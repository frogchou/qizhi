use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    codex::{
        CodexHandoffPreparationStore, CodexHandoffService, CodexProjectFiles,
        RagflowDocumentDownloader, render_ragflow_answer_markdown, render_ragflow_chunk_markdown,
    },
    contracts::{
        CodexRagflowAnswerInput, CodexRagflowChunkInput, CodexRagflowDocumentInput,
        CodexRagflowReferenceInput, CommitCodexHandoffInput,
    },
    database::Database,
    scan::configuration::{ScanRuleStore, ScanRules},
    today_workspace::WorkspaceQueryStore,
};

#[derive(Default)]
struct FakeDownloader {
    calls: Mutex<Vec<(String, String)>>,
    failing_document: Option<String>,
}

impl RagflowDocumentDownloader for FakeDownloader {
    fn download(&self, dataset_id: &str, document_id: &str) -> Result<Vec<u8>, String> {
        self.calls
            .lock()
            .unwrap()
            .push((dataset_id.to_owned(), document_id.to_owned()));
        if self.failing_document.as_deref() == Some(document_id) {
            Err("download failed".to_owned())
        } else {
            Ok(format!("document {document_id}").into_bytes())
        }
    }
}

struct Fixture {
    root: PathBuf,
    database: Database,
    service: CodexHandoffService,
    project_id: String,
    conversation_id: String,
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
            .join(format!("qizhi-ragflow-handoff-{name}-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        let database = Database::open(&root.join("qizhi.db")).unwrap();
        let rules = ScanRuleStore::open(
            &root.join("scan-rules.json"),
            ScanRules {
                allowed_roots: vec![root.to_string_lossy().to_string()],
                custom_exclusions: vec![],
                file_categories: vec![],
                directory_group_threshold: 5,
            },
        )
        .unwrap();
        let service = CodexHandoffService::new(
            database.clone(),
            CodexProjectFiles::new(root.join("projects")),
            WorkspaceQueryStore::new(),
            rules,
            CodexHandoffPreparationStore::new(),
        );
        let project = database
            .codex()
            .create_project("知识分析", None, "codex-projects/knowledge", 100)
            .unwrap();
        let conversation = database
            .codex()
            .create_conversation(&project.id, "问答资料", 101)
            .unwrap();
        Self {
            root,
            database,
            service,
            project_id: project.id,
            conversation_id: conversation.id,
        }
    }

    fn input(&self, preparation_id: &str, request_id: &str) -> CommitCodexHandoffInput {
        CommitCodexHandoffInput {
            preparation_id: preparation_id.to_owned(),
            request_id: request_id.to_owned(),
            project_id: self.project_id.clone(),
            conversation_id: self.conversation_id.clone(),
            confirm_large_files: false,
            confirm_original_only: true,
        }
    }
}

fn chunk(id: &str) -> CodexRagflowChunkInput {
    CodexRagflowChunkInput {
        chunk_id: id.to_owned(),
        content: "制度要求每周提交工作总结。".to_owned(),
        document_name: "员工手册.pdf".to_owned(),
        document_id: "document-1".to_owned(),
        dataset_id: "dataset-1".to_owned(),
        similarity: 0.91,
        retrieved_at_utc_ms: 1_800_000_000_000,
    }
}

#[test]
fn renders_chunks_and_agent_answers_without_private_thinking_or_steps() {
    let chunk_markdown = render_ragflow_chunk_markdown("如何提交周报？", &chunk("chunk-1"));
    assert!(chunk_markdown.contains("dataset-1"));
    assert!(chunk_markdown.contains("document-1"));
    assert!(chunk_markdown.contains("chunk-1"));
    assert!(chunk_markdown.contains("员工手册.pdf"));
    assert!(chunk_markdown.contains("0.9100"));
    assert!(chunk_markdown.contains("1800000000000"));

    let answer = CodexRagflowAnswerInput {
        question: "如何提交周报？".to_owned(),
        agent_id: "agent-1".to_owned(),
        agent_name: "制度助手".to_owned(),
        final_answer: "请在每周五下班前提交。".to_owned(),
        retrieved_at_utc_ms: 1_800_000_000_100,
        references: vec![CodexRagflowReferenceInput {
            citation_id: "Fig.44".to_owned(),
            chunk_id: "chunk-1".to_owned(),
            content: "每周五提交".to_owned(),
            document_name: "员工手册.pdf".to_owned(),
            document_id: "document-1".to_owned(),
            dataset_id: "dataset-1".to_owned(),
            similarity: 0.91,
        }],
    };
    let answer_markdown = render_ragflow_answer_markdown(&answer);
    assert!(answer_markdown.contains("如何提交周报？"));
    assert!(answer_markdown.contains("请在每周五下班前提交。"));
    assert!(answer_markdown.contains("Fig.44"));
    assert!(!answer_markdown.contains("thinking"));
    assert!(!answer_markdown.contains("执行步骤"));
}

#[test]
fn stores_each_agent_answer_separately_and_marks_answers_without_references() {
    let fixture = Fixture::new("answers");
    let preview = fixture
        .service
        .prepare_ragflow_answer(CodexRagflowAnswerInput {
            question: "问题".to_owned(),
            agent_id: "agent-a".to_owned(),
            agent_name: "Agent A".to_owned(),
            final_answer: "没有引用的最终回答".to_owned(),
            retrieved_at_utc_ms: 1_800_000_000_200,
            references: vec![],
        })
        .unwrap();
    fixture
        .service
        .commit_ragflow(
            fixture.input(&preview.preparation_id, "request-answer"),
            &FakeDownloader::default(),
        )
        .unwrap();

    let materials = fixture
        .database
        .codex()
        .list_materials(&fixture.project_id)
        .unwrap();
    assert_eq!(materials.len(), 1);
    assert_eq!(materials[0].kind, "ragflow_answer");
    assert!(
        materials[0]
            .source_metadata_json
            .as_deref()
            .unwrap()
            .contains("unverified_answer")
    );
}

#[test]
fn downloads_each_document_once_and_leaves_no_ready_handoff_on_partial_failure() {
    let fixture = Fixture::new("documents");
    let documents = vec![
        CodexRagflowDocumentInput {
            dataset_id: "dataset-1".to_owned(),
            document_id: "document-1".to_owned(),
            document_name: "制度.txt".to_owned(),
            retrieved_at_utc_ms: 1_800_000_000_300,
        },
        CodexRagflowDocumentInput {
            dataset_id: "dataset-1".to_owned(),
            document_id: "document-1".to_owned(),
            document_name: "制度.txt".to_owned(),
            retrieved_at_utc_ms: 1_800_000_000_300,
        },
    ];
    let preview = fixture
        .service
        .prepare_ragflow_documents(documents)
        .unwrap();
    assert_eq!(preview.file_count, 1);
    let downloader = FakeDownloader::default();
    fixture
        .service
        .commit_ragflow(
            fixture.input(&preview.preparation_id, "request-document"),
            &downloader,
        )
        .unwrap();
    assert_eq!(downloader.calls.lock().unwrap().len(), 1);

    let failed_preview = fixture
        .service
        .prepare_ragflow_documents(vec![
            CodexRagflowDocumentInput {
                dataset_id: "dataset-1".to_owned(),
                document_id: "document-2".to_owned(),
                document_name: "成功.txt".to_owned(),
                retrieved_at_utc_ms: 1_800_000_000_400,
            },
            CodexRagflowDocumentInput {
                dataset_id: "dataset-1".to_owned(),
                document_id: "document-fail".to_owned(),
                document_name: "失败.txt".to_owned(),
                retrieved_at_utc_ms: 1_800_000_000_400,
            },
        ])
        .unwrap();
    let failing = FakeDownloader {
        failing_document: Some("document-fail".to_owned()),
        ..FakeDownloader::default()
    };
    assert!(
        fixture
            .service
            .commit_ragflow(
                fixture.input(&failed_preview.preparation_id, "request-failed"),
                &failing,
            )
            .is_err()
    );
    assert!(
        fixture
            .database
            .codex()
            .find_handoff_by_request("request-failed")
            .unwrap()
            .is_none()
    );
}

#[test]
fn rejects_chunk_batches_and_fields_above_the_documented_limits() {
    let fixture = Fixture::new("limits");
    let too_many = (0..101)
        .map(|index| chunk(&format!("chunk-{index}")))
        .collect();
    assert!(
        fixture
            .service
            .prepare_ragflow_chunks("问题", too_many)
            .is_err()
    );

    let mut oversized = chunk("oversized");
    oversized.content = "字".repeat(100_001);
    assert!(
        fixture
            .service
            .prepare_ragflow_chunks("问题", vec![oversized])
            .is_err()
    );
}
