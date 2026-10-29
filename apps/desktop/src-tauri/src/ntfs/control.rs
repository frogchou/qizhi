use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use chrono::Utc;

use crate::ntfs::{
    CallerIndexPolicy, NtfsIndexRepository,
    ipc::{
        INDEXER_PROTOCOL_VERSION, IndexerRequest, IndexerRequestKind, IndexerResponse,
        IpcAuthorizationPolicy, validate_configured_roots, validate_request,
    },
};

/// The service-side control plane. Its caller SID always originates from the
/// connected pipe's token, so persisted roots cannot be re-used by another
/// local Windows account.
pub trait IndexExecutor: Send + Sync + 'static {
    fn build(&self, policy: &CallerIndexPolicy) -> Result<(), String>;
    fn sync(&self, policy: &CallerIndexPolicy) -> Result<(), String>;
}

#[derive(Clone)]
pub struct IndexerControlPlane {
    repository: NtfsIndexRepository,
    executor: Option<Arc<dyn IndexExecutor>>,
    busy: Arc<AtomicBool>,
}

impl IndexerControlPlane {
    pub fn new(repository: NtfsIndexRepository) -> Self {
        Self {
            repository,
            executor: None,
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn with_executor(
        repository: NtfsIndexRepository,
        executor: Arc<dyn IndexExecutor>,
    ) -> Self {
        Self {
            repository,
            executor: Some(executor),
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn handle(&self, caller_sid: &str, request: &IndexerRequest) -> IndexerResponse {
        if request.protocol_version != INDEXER_PROTOCOL_VERSION
            || request.request_id.trim().is_empty()
        {
            return rejected(request, "本地索引请求无效");
        }
        match &request.kind {
            IndexerRequestKind::Health => ready(request, None),
            IndexerRequestKind::Configure {
                allowed_roots,
                excluded_roots,
                file_categories,
            } => {
                if let Err(error) = validate_configured_roots(allowed_roots) {
                    return rejected(request, error.message());
                }
                let policy = CallerIndexPolicy {
                    caller_sid: caller_sid.to_owned(),
                    allowed_roots: allowed_roots.clone(),
                    excluded_roots: excluded_roots.clone(),
                    file_categories: file_categories.clone(),
                    updated_at_utc_ms: Utc::now().timestamp_millis(),
                };
                match self.repository.replace_caller_policy(&policy) {
                    Ok(()) => ready(request, Some("扫描范围已由本地索引服务保存")),
                    Err(_) => rejected(request, "无法保存本地索引服务授权配置"),
                }
            }
            IndexerRequestKind::Build | IndexerRequestKind::Sync => {
                let policy = match self.repository.caller_policy(caller_sid) {
                    Ok(Some(policy)) => policy,
                    Ok(None) => return rejected(request, "扫描范围未获本地索引服务授权"),
                    Err(_) => return rejected(request, "无法读取本地索引服务授权配置"),
                };
                let authorization = IpcAuthorizationPolicy {
                    caller_sid: policy.caller_sid.clone(),
                    allowed_roots: policy.allowed_roots.clone(),
                };
                if let Err(error) = validate_request(&authorization, caller_sid, request) {
                    return rejected(request, error.message());
                }
                self.schedule(request, policy)
            }
        }
    }

    fn schedule(&self, request: &IndexerRequest, policy: CallerIndexPolicy) -> IndexerResponse {
        let Some(executor) = self.executor.clone() else {
            return rejected(request, "本地索引服务尚未完成索引执行器配置");
        };
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return rejected(request, "本地索引服务正在处理另一项索引任务");
        }
        let operation = request.kind.clone();
        let busy = self.busy.clone();
        thread::spawn(move || {
            let _ = match operation {
                IndexerRequestKind::Build => executor.build(&policy),
                IndexerRequestKind::Sync => executor.sync(&policy),
                _ => Ok(()),
            };
            busy.store(false, Ordering::SeqCst);
        });
        IndexerResponse {
            protocol_version: INDEXER_PROTOCOL_VERSION,
            request_id: request.request_id.clone(),
            status: "accepted".to_owned(),
            message: Some("本地索引任务已在后台启动".to_owned()),
        }
    }
}

fn ready(request: &IndexerRequest, message: Option<&str>) -> IndexerResponse {
    IndexerResponse {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        status: "ready".to_owned(),
        message: message.map(str::to_owned),
    }
}

fn rejected(request: &IndexerRequest, message: &str) -> IndexerResponse {
    IndexerResponse {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        status: "rejected".to_owned(),
        message: Some(message.to_owned()),
    }
}
