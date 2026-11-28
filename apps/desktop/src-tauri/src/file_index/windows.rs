use std::path::{Path, PathBuf};

use crate::{
    contracts::FileRecordInput,
    ntfs::ipc::{INDEXER_PROTOCOL_VERSION, IndexerRequest, IndexerRequestKind, IndexerResponse},
    scan::{
        configuration::ScanRules,
        file_filter::FileCategory,
        policy::{AllowedRoot, active_roots, display_path},
    },
};

use super::{
    IndexError, IndexPeriod, IndexRefresh, IndexSnapshot, IndexStatus, resolved_size_bytes,
};

type PipeClient = fn(&IndexerRequest) -> Result<IndexerResponse, String>;

#[derive(Clone)]
pub struct WindowsFileIndex<Client = PipeClient> {
    call: Client,
}

#[cfg(windows)]
impl Default for WindowsFileIndex {
    fn default() -> Self {
        Self {
            call: crate::ntfs::pipe::call_indexer_service,
        }
    }
}

impl<Client> WindowsFileIndex<Client>
where
    Client: Fn(&IndexerRequest) -> Result<IndexerResponse, String>,
{
    fn request(
        &self,
        label: &str,
        kind: IndexerRequestKind,
    ) -> Result<IndexerResponse, IndexError> {
        (self.call)(&IndexerRequest {
            protocol_version: INDEXER_PROTOCOL_VERSION,
            request_id: format!("{label}-{}", chrono::Utc::now().timestamp_millis()),
            kind,
        })
        .map_err(IndexError)
    }

    fn configure_roots(
        &self,
        label: &str,
        roots: &[AllowedRoot],
        excluded_roots: Vec<String>,
        categories: &[FileCategory],
    ) -> Result<(), IndexError> {
        let response = self.request(
            label,
            IndexerRequestKind::Configure {
                allowed_roots: roots.iter().map(|root| display_path(&root.0)).collect(),
                excluded_roots,
                file_categories: categories.to_vec(),
            },
        )?;
        if response.status == "ready" {
            return Ok(());
        }
        Err(IndexError(response.message.unwrap_or_else(|| {
            "本地 NTFS 索引服务拒绝了扫描范围。".to_owned()
        })))
    }

    pub fn configure(&self, rules: &ScanRules) -> Result<(), IndexError> {
        let exclusions = rules
            .custom_exclusions
            .iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        let roots = active_roots(&rules.allowed_roots, &exclusions)
            .map_err(|_| IndexError("扫描目录无效，请在设置中重新保存。".to_owned()))?;
        self.configure_roots(
            "desktop-configure",
            &roots,
            rules.custom_exclusions.clone(),
            &rules.file_categories,
        )
    }

    pub fn refresh_range(&self, refresh: IndexRefresh<'_>) -> Result<IndexSnapshot, IndexError> {
        let (configure_label, sync_label, list_label, missing_files) = match refresh.period {
            IndexPeriod::Today => (
                "today-configure",
                "today-sync",
                "today-list",
                "本地 NTFS 索引服务无法返回今日文件。",
            ),
            IndexPeriod::Recent => (
                "recent-configure",
                "recent-sync",
                "recent-list",
                "本地 NTFS 索引服务无法返回过去文件。",
            ),
        };
        self.configure_roots(
            configure_label,
            refresh.roots,
            refresh
                .exclusions
                .iter()
                .map(|path| display_path(path))
                .collect(),
            refresh.categories,
        )?;
        let response = self.request(sync_label, IndexerRequestKind::Sync)?;
        if !matches!(response.status.as_str(), "accepted" | "ready") {
            return Err(IndexError(
                response
                    .message
                    .unwrap_or_else(|| "本地 NTFS 索引服务无法启动同步。".to_owned()),
            ));
        }

        let response = self.request(
            list_label,
            IndexerRequestKind::ListToday {
                start_utc_ms: refresh.range.start_utc_ms,
                end_utc_ms: refresh.range.next_start_utc_ms,
            },
        )?;
        if response.status != "ready" {
            return Err(IndexError(
                response.message.unwrap_or_else(|| missing_files.to_owned()),
            ));
        }
        Ok(IndexSnapshot {
            records: response
                .candidates
                .into_iter()
                .map(|candidate| FileRecordInput {
                    size_bytes: resolved_size_bytes(
                        Path::new(&candidate.canonical_path),
                        candidate.size_bytes,
                    ),
                    canonical_path: candidate.canonical_path,
                    file_identity: candidate.file_reference_number,
                    modified_at_utc_ms: candidate.modified_at_utc_ms,
                    source: "本机 NTFS 索引".to_owned(),
                })
                .collect(),
        })
    }

    pub fn status(&self) -> IndexStatus {
        match self.request("desktop-health", IndexerRequestKind::Health) {
            Ok(response) if response.status == "ready" => IndexStatus {
                available: true,
                message: "本地 NTFS 索引服务已连接。".to_owned(),
            },
            Ok(response) => IndexStatus {
                available: false,
                message: response
                    .message
                    .unwrap_or_else(|| "本地 NTFS 索引服务暂不可用。".to_owned()),
            },
            Err(error) => IndexStatus {
                available: false,
                message: error.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use crate::{contracts::LocalDayRange, ntfs::ipc::IndexerFileCandidate};

    use super::*;

    fn reply(request: &IndexerRequest, status: &str) -> IndexerResponse {
        IndexerResponse {
            protocol_version: INDEXER_PROTOCOL_VERSION,
            request_id: request.request_id.clone(),
            status: status.to_owned(),
            message: None,
            candidates: vec![],
        }
    }

    #[test]
    fn refresh_configures_then_syncs_then_lists_using_either_calendar_range() {
        for period in [IndexPeriod::Today, IndexPeriod::Recent] {
            let calls = RefCell::new(Vec::new());
            let index = WindowsFileIndex {
                call: |request: &IndexerRequest| {
                    assert_eq!(request.protocol_version, INDEXER_PROTOCOL_VERSION);
                    calls.borrow_mut().push(request.kind.clone());
                    let mut response = reply(request, "ready");
                    match request.kind {
                        IndexerRequestKind::Sync => response.status = "accepted".to_owned(),
                        IndexerRequestKind::ListToday { .. } => {
                            response.candidates.push(IndexerFileCandidate {
                                file_reference_number: "ntfs:42".to_owned(),
                                canonical_path: r"D:\Work\周报.md".to_owned(),
                                modified_at_utc_ms: 1200,
                                size_bytes: Some(9),
                            })
                        }
                        _ => {}
                    }
                    Ok(response)
                },
            };
            let snapshot = index
                .refresh_range(IndexRefresh {
                    period,
                    range: LocalDayRange::new(1000, 2000),
                    roots: &[AllowedRoot(PathBuf::from(r"D:\Work"))],
                    exclusions: &[PathBuf::from(r"D:\Work\Private")],
                    categories: &[FileCategory::Documents],
                })
                .expect("index snapshot");

            assert_eq!(
                *calls.borrow(),
                [
                    IndexerRequestKind::Configure {
                        allowed_roots: vec![r"D:\Work".to_owned()],
                        excluded_roots: vec![r"D:\Work\Private".to_owned()],
                        file_categories: vec![FileCategory::Documents],
                    },
                    IndexerRequestKind::Sync,
                    IndexerRequestKind::ListToday {
                        start_utc_ms: 1000,
                        end_utc_ms: 2000
                    },
                ]
            );
            assert_eq!(snapshot.records[0].file_identity, "ntfs:42");
            assert_eq!(snapshot.records[0].source, "本机 NTFS 索引");
        }
    }

    #[test]
    fn rejected_sync_does_not_query_the_previous_snapshot() {
        let calls = RefCell::new(Vec::new());
        let index = WindowsFileIndex {
            call: |request: &IndexerRequest| {
                calls.borrow_mut().push(request.kind.clone());
                let mut response = reply(request, "ready");
                if request.kind == IndexerRequestKind::Sync {
                    response.status = "error".to_owned();
                    response.message = Some("卷暂不可用".to_owned());
                }
                Ok(response)
            },
        };
        let error = index
            .refresh_range(IndexRefresh {
                period: IndexPeriod::Recent,
                range: LocalDayRange::new(1000, 2000),
                roots: &[],
                exclusions: &[],
                categories: &[],
            })
            .expect_err("failed sync");

        assert_eq!(error.to_string(), "卷暂不可用");
        assert_eq!(calls.borrow().len(), 2);
    }

    #[test]
    fn status_and_saved_scope_preserve_the_local_pipe_contract() {
        let index = WindowsFileIndex {
            call: |request: &IndexerRequest| {
                assert!(matches!(
                    request.kind,
                    IndexerRequestKind::Configure { .. } | IndexerRequestKind::Health
                ));
                Ok(reply(request, "ready"))
            },
        };
        index.configure(&ScanRules::default()).expect("configure");
        let status = index.status();
        assert!(status.available);
        assert!(status.message.contains("NTFS"));
    }
}
