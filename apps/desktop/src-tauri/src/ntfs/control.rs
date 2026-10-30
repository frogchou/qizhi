use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use chrono::Utc;

use crate::ntfs::{
    CallerIndexPolicy, IndexedFileCandidate, NtfsIndexRepository,
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

    pub fn list_visible_candidates(
        &self,
        caller_sid: &str,
        start_utc_ms: i64,
        end_utc_ms: i64,
    ) -> Result<Vec<IndexedFileCandidate>, String> {
        let policy = self
            .repository
            .caller_policy(caller_sid)
            .map_err(|_| "无法读取本地索引服务授权配置".to_owned())?
            .ok_or_else(|| "扫描范围未获本地索引服务授权".to_owned())?;
        let exclusions = policy
            .excluded_roots
            .iter()
            .map(std::path::PathBuf::from)
            .collect::<Vec<_>>();
        let roots = crate::scan::policy::active_roots(&policy.allowed_roots, &exclusions)
            .map_err(|_| "本地索引服务保存的扫描范围无效".to_owned())?;
        let visibility = crate::scan::policy::ScanPolicy::for_roots(exclusions, roots);
        let type_filter = crate::scan::file_filter::FileTypeFilter::new(policy.file_categories);
        self.repository
            .list_file_candidates_between(start_utc_ms, end_utc_ms)
            .map_err(|_| "无法查询本地 NTFS 索引".to_owned())
            .map(|candidates| {
                candidates
                    .into_iter()
                    .filter(|candidate| {
                        let path = std::path::Path::new(&candidate.canonical_path);
                        visibility.is_cached_path_allowed(path) && type_filter.allows(path)
                    })
                    .collect()
            })
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
                match request.kind {
                    IndexerRequestKind::Build => self.schedule(request, policy),
                    IndexerRequestKind::Sync => self.sync_now(request, policy),
                    _ => unreachable!("request kind is matched above"),
                }
            }
            IndexerRequestKind::ListToday {
                start_utc_ms,
                end_utc_ms,
            } => {
                let candidates =
                    match self.list_visible_candidates(caller_sid, *start_utc_ms, *end_utc_ms) {
                        Ok(candidates) => candidates,
                        Err(message) => return rejected(request, &message),
                    };
                IndexerResponse {
                    protocol_version: INDEXER_PROTOCOL_VERSION,
                    request_id: request.request_id.clone(),
                    status: "ready".to_owned(),
                    message: None,
                    candidates: candidates
                        .into_iter()
                        .map(|candidate| crate::ntfs::ipc::IndexerFileCandidate {
                            file_reference_number: candidate.file_reference_number,
                            canonical_path: candidate.canonical_path,
                            modified_at_utc_ms: candidate.modified_at_utc_ms,
                            size_bytes: candidate.size_bytes,
                        })
                        .collect(),
                }
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
            candidates: vec![],
        }
    }

    fn sync_now(&self, request: &IndexerRequest, policy: CallerIndexPolicy) -> IndexerResponse {
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
        let result = executor.sync(&policy);
        self.busy.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => ready(request, Some("本地 NTFS 索引已同步")),
            Err(error) => rejected(
                request,
                &format!(
                    "本地 NTFS 索引同步失败：{}",
                    local_diagnostic_message(&error)
                ),
            ),
        }
    }
}

fn local_diagnostic_message(message: &str) -> String {
    const MAX_DIAGNOSTIC_CHARS: usize = 240;
    let normalized = message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return "未返回可用诊断信息".to_owned();
    }
    let mut result = trimmed
        .chars()
        .take(MAX_DIAGNOSTIC_CHARS)
        .collect::<String>();
    if trimmed.chars().count() > MAX_DIAGNOSTIC_CHARS {
        result.push('…');
    }
    result
}

fn ready(request: &IndexerRequest, message: Option<&str>) -> IndexerResponse {
    IndexerResponse {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        status: "ready".to_owned(),
        message: message.map(str::to_owned),
        candidates: vec![],
    }
}

fn rejected(request: &IndexerRequest, message: &str) -> IndexerResponse {
    IndexerResponse {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        status: "rejected".to_owned(),
        message: Some(message.to_owned()),
        candidates: vec![],
    }
}
