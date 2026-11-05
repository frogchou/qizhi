use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    app_state::AppState,
    codex::{CodexHandoffPreparationStore, CodexHandoffService, CodexProjectFiles, CodexRuntime},
    commands::codex_handoff::{
        CommitCodexHandoffCommandInput, DismissCodexHandoffItemInput, PrepareCodexHandoffInput,
        PrepareCodexHandoffSource, commit_handoff, dismiss_handoff_item, list_pending_handoffs,
        prepare_handoff,
    },
    contracts::{CodexRagflowDocumentInput, FileRecordInput},
    database::Database,
    scan::{
        configuration::{ScanRuleStore, ScanRules},
        file_filter::FileCategory,
        progress::TodayScanProgress,
    },
    telemetry::AppLogger,
    today_workspace::{
        WorkspaceBuildInput, WorkspaceCategory, WorkspaceQueryStore, WorkspaceSort, WorkspaceTree,
    },
};

#[test]
fn deserializes_workspace_handoff_fields_from_the_frontend_camel_case_contract() {
    let today: PrepareCodexHandoffInput = serde_json::from_value(serde_json::json!({
        "source": {
            "kind": "today",
            "queryId": "query-today",
            "fileIds": [7, 8],
            "directoryIds": ["directory-1"]
        }
    }))
    .expect("Today handoff input should accept the frontend camelCase contract");

    match today.source {
        PrepareCodexHandoffSource::Today {
            query_id,
            file_ids,
            directory_ids,
        } => {
            assert_eq!(query_id, "query-today");
            assert_eq!(file_ids, vec![7, 8]);
            assert_eq!(directory_ids, vec!["directory-1"]);
        }
        other => panic!("unexpected source: {other:?}"),
    }

    let recent: PrepareCodexHandoffInput = serde_json::from_value(serde_json::json!({
        "source": {
            "kind": "recent",
            "queryId": "query-recent",
            "fileIds": [9],
            "directoryIds": []
        }
    }))
    .expect("Recent handoff input should use the same field naming contract");
    assert!(matches!(
        recent.source,
        PrepareCodexHandoffSource::Recent { query_id, file_ids, .. }
            if query_id == "query-recent" && file_ids == vec![9]
    ));
}

struct Fixture {
    root: PathBuf,
    state: AppState,
    project_id: String,
    conversation_id: String,
    query_id: String,
    file_id: i64,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Fixture {
    fn new(name: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("qizhi-handoff-command-{name}-{nonce}"));
        let sources = root.join("sources");
        fs::create_dir_all(&sources).unwrap();
        let source = sources.join("report.md");
        fs::write(&source, "# 工作报告").unwrap();
        let database = Database::open(&root.join("qizhi.db")).unwrap();
        database
            .files()
            .upsert(&FileRecordInput {
                canonical_path: source.to_string_lossy().to_string(),
                file_identity: "command-report".to_owned(),
                modified_at_utc_ms: 10,
                size_bytes: 13,
                source: "本机 NTFS 索引".to_owned(),
            })
            .unwrap();
        let record = database
            .files()
            .get_by_identity(&source.to_string_lossy(), "command-report")
            .unwrap()
            .unwrap();
        let rules = ScanRuleStore::open(
            &root.join("scan-rules.json"),
            ScanRules {
                allowed_roots: vec![sources.to_string_lossy().to_string()],
                custom_exclusions: vec![],
                file_categories: vec![FileCategory::Documents],
                directory_group_threshold: 5,
            },
        )
        .unwrap();
        let queries = WorkspaceQueryStore::new();
        let tree = WorkspaceTree::build(WorkspaceBuildInput {
            files: vec![record.clone()],
            allowed_roots: vec![sources.to_string_lossy().to_string()],
            threshold: 5,
            category: WorkspaceCategory::Documents,
            search: String::new(),
            value_statuses: HashMap::new(),
        })
        .unwrap();
        let query_id = queries.insert(tree, WorkspaceSort::NameAsc).unwrap();
        let project_files = CodexProjectFiles::new(root.join("projects"));
        let service = CodexHandoffService::new(
            database.clone(),
            project_files.clone(),
            queries.clone(),
            rules.clone(),
            CodexHandoffPreparationStore::new(),
        );
        let runtime = CodexRuntime::new(database.clone(), project_files);
        let project = database
            .codex()
            .create_project("交接项目", None, "managed", 100)
            .unwrap();
        let conversation = database
            .codex()
            .create_conversation(&project.id, "资料会话", 101)
            .unwrap();
        let state = AppState {
            database,
            scan_rules: rules,
            today_scan_progress: TodayScanProgress::new(),
            logger: AppLogger::new(&root),
            workspace_queries: queries,
            codex_runtime: runtime,
            codex_handoffs: service,
            knowledge_selections:
                qizhi_desktop_lib::knowledge_selection::KnowledgeSelectionStore::default(),
        };
        Self {
            root,
            state,
            project_id: project.id,
            conversation_id: conversation.id,
            query_id,
            file_id: record.id,
        }
    }

    fn prepare(&self) -> qizhi_desktop_lib::contracts::CodexHandoffPreview {
        prepare_handoff(
            &self.state,
            PrepareCodexHandoffInput {
                source: PrepareCodexHandoffSource::Today {
                    query_id: self.query_id.clone(),
                    file_ids: vec![self.file_id],
                    directory_ids: vec![],
                },
            },
        )
        .unwrap()
    }
}

#[test]
fn prepares_a_controlled_source_and_commits_only_to_its_matching_active_conversation() {
    let fixture = Fixture::new("commit");
    let preview = fixture.prepare();
    let result = commit_handoff(
        &fixture.state,
        CommitCodexHandoffCommandInput {
            source_kind: preview.source_kind,
            preparation_id: preview.preparation_id,
            request_id: "command-request".to_owned(),
            project_id: fixture.project_id.clone(),
            conversation_id: fixture.conversation_id.clone(),
            confirm_large_files: false,
            confirm_original_only: false,
        },
    )
    .unwrap();
    assert_eq!(result.status, "ready");
    assert_eq!(
        list_pending_handoffs(&fixture.state, &fixture.conversation_id)
            .unwrap()
            .len(),
        1
    );

    let pending = fixture
        .state
        .database
        .codex()
        .list_pending_handoffs(&fixture.conversation_id)
        .unwrap();
    dismiss_handoff_item(
        &fixture.state,
        &DismissCodexHandoffItemInput {
            handoff_id: pending[0].handoff.id.clone(),
            material_id: pending[0].items[0].material_id.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        list_pending_handoffs(&fixture.state, &fixture.conversation_id).unwrap()[0].items[0].state,
        "dismissed"
    );
}

#[test]
fn accepts_only_ragflow_documents_from_the_recorded_query_result() {
    let fixture = Fixture::new("ragflow-provenance");
    let token = fixture
        .state
        .knowledge_selections
        .register([("dataset-1".to_owned(), "document-1".to_owned())]);
    let document = CodexRagflowDocumentInput {
        dataset_id: "dataset-1".to_owned(),
        document_id: "document-1".to_owned(),
        document_name: "报告.docx".to_owned(),
        retrieved_at_utc_ms: 10,
    };
    assert!(
        prepare_handoff(
            &fixture.state,
            PrepareCodexHandoffInput {
                source: PrepareCodexHandoffSource::RagflowDocuments {
                    selection_token: token.clone(),
                    documents: vec![document],
                },
            },
        )
        .is_ok()
    );
    let forged = CodexRagflowDocumentInput {
        dataset_id: "dataset-1".to_owned(),
        document_id: "other-document".to_owned(),
        document_name: "未知.docx".to_owned(),
        retrieved_at_utc_ms: 10,
    };
    assert!(
        prepare_handoff(
            &fixture.state,
            PrepareCodexHandoffInput {
                source: PrepareCodexHandoffSource::RagflowDocuments {
                    selection_token: token,
                    documents: vec![forged],
                },
            },
        )
        .unwrap_err()
        .contains("重新查询")
    );
}

#[test]
fn returns_safe_errors_for_empty_expired_archived_busy_and_cross_project_targets() {
    let fixture = Fixture::new("guards");
    let empty = prepare_handoff(
        &fixture.state,
        PrepareCodexHandoffInput {
            source: PrepareCodexHandoffSource::Today {
                query_id: fixture.query_id.clone(),
                file_ids: vec![],
                directory_ids: vec![],
            },
        },
    )
    .unwrap_err();
    assert!(empty.contains("没有可发送"));

    let expired = commit_handoff(
        &fixture.state,
        CommitCodexHandoffCommandInput {
            source_kind: "today".to_owned(),
            preparation_id: "missing".to_owned(),
            request_id: "expired".to_owned(),
            project_id: fixture.project_id.clone(),
            conversation_id: fixture.conversation_id.clone(),
            confirm_large_files: false,
            confirm_original_only: false,
        },
    )
    .unwrap_err();
    assert!(expired.contains("过期"));

    let other = fixture
        .state
        .database
        .codex()
        .create_project("其他项目", None, "managed-2", 102)
        .unwrap();
    let preview = fixture.prepare();
    let cross_project = commit_handoff(
        &fixture.state,
        CommitCodexHandoffCommandInput {
            source_kind: preview.source_kind,
            preparation_id: preview.preparation_id,
            request_id: "cross-project".to_owned(),
            project_id: other.id,
            conversation_id: fixture.conversation_id.clone(),
            confirm_large_files: false,
            confirm_original_only: false,
        },
    )
    .unwrap_err();
    assert!(!cross_project.contains(&fixture.root.to_string_lossy().to_string()));

    let preview = fixture.prepare();
    fixture
        .state
        .database
        .codex()
        .create_turn(&fixture.conversation_id, "running", 103)
        .unwrap();
    let busy = commit_handoff(
        &fixture.state,
        CommitCodexHandoffCommandInput {
            source_kind: preview.source_kind,
            preparation_id: preview.preparation_id,
            request_id: "busy".to_owned(),
            project_id: fixture.project_id.clone(),
            conversation_id: fixture.conversation_id.clone(),
            confirm_large_files: false,
            confirm_original_only: false,
        },
    )
    .unwrap_err();
    assert!(busy.contains("正在执行"));
}

#[test]
fn duplicate_request_ids_return_the_same_ready_handoff_and_archived_targets_are_rejected() {
    let fixture = Fixture::new("idempotent");
    let preview = fixture.prepare();
    let input = CommitCodexHandoffCommandInput {
        source_kind: preview.source_kind,
        preparation_id: preview.preparation_id,
        request_id: "same-request".to_owned(),
        project_id: fixture.project_id.clone(),
        conversation_id: fixture.conversation_id.clone(),
        confirm_large_files: false,
        confirm_original_only: false,
    };
    let first = commit_handoff(&fixture.state, input.clone()).unwrap();
    let second = commit_handoff(&fixture.state, input).unwrap();
    assert_eq!(first.handoff_id, second.handoff_id);

    fixture
        .state
        .database
        .codex()
        .set_project_status(&fixture.project_id, "archived", 200)
        .unwrap();
    let preview = fixture.prepare();
    let archived = commit_handoff(
        &fixture.state,
        CommitCodexHandoffCommandInput {
            source_kind: preview.source_kind,
            preparation_id: preview.preparation_id,
            request_id: "archived".to_owned(),
            project_id: fixture.project_id.clone(),
            conversation_id: fixture.conversation_id.clone(),
            confirm_large_files: false,
            confirm_original_only: false,
        },
    )
    .unwrap_err();
    assert!(
        archived.contains("目标") || archived.contains("不可用"),
        "unexpected archived-target error: {archived}"
    );
}
