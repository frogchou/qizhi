use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    codex::{
        CodexHandoffPreparationStore, CodexHandoffService, CodexHandoffServiceError,
        CodexProjectFiles,
    },
    contracts::{CommitCodexHandoffInput, FileRecord, FileRecordInput},
    database::Database,
    scan::{
        configuration::{ScanRuleStore, ScanRules},
        file_filter::FileCategory,
    },
    today_workspace::{
        WorkspaceBuildInput, WorkspaceCategory, WorkspaceQueryStore, WorkspaceSort, WorkspaceTree,
    },
};

struct Fixture {
    root: PathBuf,
    database: Database,
    rules: ScanRuleStore,
    queries: WorkspaceQueryStore,
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
            .join(format!("qizhi-handoff-service-{name}-{nonce}"));
        fs::create_dir_all(root.join("sources")).unwrap();
        let database = Database::open(&root.join("qizhi.db")).unwrap();
        let rules = ScanRuleStore::open(
            &root.join("scan-rules.json"),
            ScanRules {
                allowed_roots: vec![root.join("sources").to_string_lossy().to_string()],
                custom_exclusions: vec![],
                file_categories: vec![FileCategory::Documents, FileCategory::SourceCode],
                directory_group_threshold: 5,
            },
        )
        .unwrap();
        let queries = WorkspaceQueryStore::new();
        let files = CodexProjectFiles::new(root.join("codex-projects"));
        let service = CodexHandoffService::new(
            database.clone(),
            files,
            queries.clone(),
            rules.clone(),
            CodexHandoffPreparationStore::new(),
        );
        let project = database
            .codex()
            .create_project("测试项目", None, "codex-projects/test", 100)
            .unwrap();
        let conversation = database
            .codex()
            .create_conversation(&project.id, "测试会话", 101)
            .unwrap();
        Self {
            root,
            database,
            rules,
            queries,
            service,
            project_id: project.id,
            conversation_id: conversation.id,
        }
    }

    fn add_file(&self, name: &str, bytes: &[u8], modified_at: i64) -> FileRecord {
        let path = self.root.join("sources").join(name);
        fs::write(&path, bytes).unwrap();
        let identity = format!("identity-{name}");
        self.database
            .files()
            .upsert(&FileRecordInput {
                canonical_path: path.to_string_lossy().to_string(),
                file_identity: identity.clone(),
                modified_at_utc_ms: modified_at,
                size_bytes: bytes.len() as i64,
                source: "本机 NTFS 索引".to_owned(),
            })
            .unwrap();
        self.database
            .files()
            .get_by_identity(&path.to_string_lossy(), &identity)
            .unwrap()
            .unwrap()
    }

    fn query(&self, files: Vec<FileRecord>) -> String {
        let tree = WorkspaceTree::build(WorkspaceBuildInput {
            files,
            allowed_roots: vec![self.root.join("sources").to_string_lossy().to_string()],
            threshold: 5,
            category: WorkspaceCategory::All,
            search: String::new(),
            value_statuses: HashMap::new(),
        })
        .unwrap();
        self.queries.insert(tree, WorkspaceSort::NameAsc).unwrap()
    }

    fn commit_input(&self, preparation_id: &str, request_id: &str) -> CommitCodexHandoffInput {
        CommitCodexHandoffInput {
            preparation_id: preparation_id.to_owned(),
            request_id: request_id.to_owned(),
            project_id: self.project_id.clone(),
            conversation_id: self.conversation_id.clone(),
            confirm_large_files: false,
            confirm_original_only: false,
        }
    }
}

#[test]
fn commits_stable_selection_preserves_same_content_sources_and_is_idempotent() {
    let fixture = Fixture::new("commit");
    let first = fixture.add_file("first.txt", b"same content", 1_000);
    let second = fixture.add_file("second.txt", b"same content", 1_001);
    let query_id = fixture.query(vec![first.clone(), second.clone()]);
    let preview = fixture
        .service
        .prepare_today(&query_id, &[first.id, second.id], &[])
        .unwrap();
    assert_eq!(preview.file_count, 2);
    assert_eq!(preview.total_size_bytes, 24);

    let input = fixture.commit_input(&preview.preparation_id, "request-stable");
    let committed = fixture.service.commit_local(input.clone()).unwrap();
    let repeated = fixture.service.commit_local(input).unwrap();
    assert_eq!(repeated.handoff_id, committed.handoff_id);
    assert_eq!(
        fixture
            .database
            .codex()
            .list_materials(&fixture.project_id)
            .unwrap()
            .len(),
        2
    );

    let second_preview = fixture
        .service
        .prepare_today(&query_id, &[first.id], &[])
        .unwrap();
    let second_commit = fixture
        .service
        .commit_local(fixture.commit_input(&second_preview.preparation_id, "request-reuse"))
        .unwrap();
    assert_ne!(second_commit.handoff_id, committed.handoff_id);
    assert_eq!(
        fixture
            .database
            .codex()
            .list_materials(&fixture.project_id)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn rejects_sources_that_changed_disappeared_or_became_excluded_after_preview() {
    let fixture = Fixture::new("stale");
    let file = fixture.add_file("report.md", b"draft", 2_000);
    let query_id = fixture.query(vec![file.clone()]);
    let preview = fixture
        .service
        .prepare_today(&query_id, &[file.id], &[])
        .unwrap();
    fs::write(fixture.root.join("sources/report.md"), b"changed content").unwrap();
    assert!(matches!(
        fixture
            .service
            .commit_local(fixture.commit_input(&preview.preparation_id, "request-changed")),
        Err(CodexHandoffServiceError::SourceChanged)
    ));

    let missing = fixture.add_file("missing.md", b"exists", 2_100);
    let missing_query = fixture.query(vec![missing.clone()]);
    let missing_preview = fixture
        .service
        .prepare_today(&missing_query, &[missing.id], &[])
        .unwrap();
    fs::remove_file(fixture.root.join("sources/missing.md")).unwrap();
    assert!(matches!(
        fixture
            .service
            .commit_local(fixture.commit_input(&missing_preview.preparation_id, "request-missing")),
        Err(CodexHandoffServiceError::SourceUnavailable)
    ));

    let excluded = fixture.add_file("excluded.md", b"secret", 2_200);
    let excluded_query = fixture.query(vec![excluded.clone()]);
    let excluded_preview = fixture
        .service
        .prepare_today(&excluded_query, &[excluded.id], &[])
        .unwrap();
    let mut rules = fixture.rules.get().unwrap();
    rules.custom_exclusions = vec![fixture.root.join("sources").to_string_lossy().to_string()];
    fixture.rules.save(rules).unwrap();
    assert!(matches!(
        fixture.service.commit_local(
            fixture.commit_input(&excluded_preview.preparation_id, "request-excluded")
        ),
        Err(CodexHandoffServiceError::SourceUnavailable)
    ));
}

#[test]
fn surfaces_confirmation_and_busy_project_guards() {
    let fixture = Fixture::new("guards");
    let legacy = fixture.add_file("legacy.doc", b"legacy", 3_000);
    let legacy_query = fixture.query(vec![legacy.clone()]);
    let legacy_preview = fixture
        .service
        .prepare_today(&legacy_query, &[legacy.id], &[])
        .unwrap();
    assert_eq!(legacy_preview.blocked_items.len(), 1);

    let large_path = fixture.root.join("sources/large.txt");
    let large_file = fs::File::create(&large_path).unwrap();
    large_file.set_len(50 * 1024 * 1024 + 1).unwrap();
    let large = fixture.add_file("large.txt", b"", 3_100);
    fs::OpenOptions::new()
        .write(true)
        .open(&large_path)
        .unwrap()
        .set_len(50 * 1024 * 1024 + 1)
        .unwrap();
    fixture
        .database
        .files()
        .upsert(&FileRecordInput {
            canonical_path: large.canonical_path.clone(),
            file_identity: large.file_identity.clone(),
            modified_at_utc_ms: large.modified_at_utc_ms,
            size_bytes: 50 * 1024 * 1024 + 1,
            source: large.source.clone(),
        })
        .unwrap();
    let large = fixture
        .database
        .files()
        .get_by_id(large.id)
        .unwrap()
        .unwrap();
    let large_query = fixture.query(vec![large.clone()]);
    let large_preview = fixture
        .service
        .prepare_today(&large_query, &[large.id], &[])
        .unwrap();
    assert!(large_preview.requires_large_file_confirmation);

    let corrupt = fixture.add_file("corrupt.docx", b"not a zip", 3_200);
    let corrupt_query = fixture.query(vec![corrupt.clone()]);
    let corrupt_preview = fixture
        .service
        .prepare_today(&corrupt_query, &[corrupt.id], &[])
        .unwrap();
    let corrupt_input = fixture.commit_input(&corrupt_preview.preparation_id, "request-corrupt");
    assert!(matches!(
        fixture.service.commit_local(corrupt_input.clone()),
        Err(CodexHandoffServiceError::OriginalOnlyConfirmationRequired)
    ));
    let mut confirmed = corrupt_input;
    confirmed.confirm_original_only = true;
    assert!(fixture.service.commit_local(confirmed).is_ok());

    let busy = fixture.add_file("busy.md", b"busy", 3_300);
    let busy_query = fixture.query(vec![busy.clone()]);
    let busy_preview = fixture
        .service
        .prepare_today(&busy_query, &[busy.id], &[])
        .unwrap();
    fixture
        .database
        .codex()
        .create_turn(&fixture.conversation_id, "running", 3_301)
        .unwrap();
    assert!(matches!(
        fixture
            .service
            .commit_local(fixture.commit_input(&busy_preview.preparation_id, "request-busy")),
        Err(CodexHandoffServiceError::ProjectBusy)
    ));
}
