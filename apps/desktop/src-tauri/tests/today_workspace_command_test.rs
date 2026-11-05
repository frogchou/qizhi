use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    app_state::AppState,
    codex::{CodexHandoffPreparationStore, CodexHandoffService, CodexProjectFiles, CodexRuntime},
    commands::today::{
        WorkspaceQueryInput, WorkspaceScope, WorkspaceSelectionInput, expand_workspace_query,
        query_workspace, resolve_workspace_selection,
    },
    commands::value::workspace_evaluation_candidate_ids,
    contracts::FileRecordInput,
    database::Database,
    scan::{
        configuration::{ScanRuleStore, ScanRules},
        file_filter::FileCategory,
        progress::TodayScanProgress,
    },
    telemetry::AppLogger,
    today_workspace::{WorkspaceCategory, WorkspaceQueryStore, WorkspaceSort},
};

struct Fixture {
    state: AppState,
    root: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn fixture() -> Fixture {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::current_dir()
        .expect("current directory")
        .join("target")
        .join(format!("qizhi-workspace-command-{nonce}"));
    let project = root.join("ProjectA").join("src");
    fs::create_dir_all(&project).expect("fixture directories");
    let database = Database::open(&root.join("qizhi.db")).expect("database");
    let (start, _) = qizhi_desktop_lib::commands::today::current_day_bounds();
    for (offset, name) in [(1, "one.md"), (2, "two.md"), (3, "three.md")] {
        let path = project.join(name);
        fs::write(&path, format!("document {offset}")).expect("fixture file");
        database
            .files()
            .upsert(&FileRecordInput {
                canonical_path: path.to_string_lossy().to_string(),
                file_identity: format!("fixture-{offset}"),
                modified_at_utc_ms: start + offset,
                size_bytes: 10,
                source: "本机 NTFS 索引".to_owned(),
            })
            .expect("indexed fixture");
    }
    let rules = ScanRuleStore::open(
        &root.join("scan-rules.json"),
        ScanRules {
            allowed_roots: vec![root.to_string_lossy().to_string()],
            custom_exclusions: vec![],
            file_categories: vec![FileCategory::Documents, FileCategory::SourceCode],
            directory_group_threshold: 2,
        },
    )
    .expect("rules");
    let project_files = CodexProjectFiles::new(root.join("codex-projects"));
    let workspace_queries = WorkspaceQueryStore::new();
    let codex_handoffs = CodexHandoffService::new(
        database.clone(),
        project_files.clone(),
        workspace_queries.clone(),
        rules.clone(),
        CodexHandoffPreparationStore::new(),
    );
    let codex_runtime = CodexRuntime::new(database.clone(), project_files);
    Fixture {
        state: AppState {
            database,
            scan_rules: rules,
            today_scan_progress: TodayScanProgress::new(),
            logger: AppLogger::new(&root),
            workspace_queries,
            codex_runtime,
            codex_handoffs,
            knowledge_selections:
                qizhi_desktop_lib::knowledge_selection::KnowledgeSelectionStore::default(),
        },
        root,
    }
}

fn query_input() -> WorkspaceQueryInput {
    WorkspaceQueryInput {
        scope: WorkspaceScope::Today,
        days: None,
        category: WorkspaceCategory::Documents,
        search: String::new(),
        sort: WorkspaceSort::NameAsc,
    }
}

#[test]
fn root_query_expands_and_mixed_selection_is_deduplicated() {
    let fixture = fixture();
    let root = query_workspace(&fixture.state, query_input()).expect("root query");
    assert!(!root.query_id.is_empty());
    assert_eq!(root.total_file_count, 3);
    assert_eq!(root.entries.len(), 1);

    let child = expand_workspace_query(&fixture.state, &root.query_id, &root.entries[0].id, 0)
        .expect("expand parent");
    assert_eq!(child.entries.len(), 1);
    let directory_id = child.entries[0].id.clone();
    let nested = expand_workspace_query(&fixture.state, &root.query_id, &directory_id, 0)
        .expect("expand grouped directory");
    let explicit = nested.entries[0].file_id.expect("file row");

    let selected = resolve_workspace_selection(
        &fixture.state,
        WorkspaceSelectionInput {
            query_id: root.query_id,
            file_ids: vec![explicit],
            directory_ids: vec![directory_id],
        },
    )
    .expect("resolve selection");
    assert_eq!(selected.file_count, 3);
    assert_eq!(selected.batch_count, 1);
    assert_eq!(selected.file_ids.len(), 3);
}

#[test]
fn selection_rechecks_deleted_and_newly_excluded_files() {
    let fixture = fixture();
    let root = query_workspace(&fixture.state, query_input()).expect("root query");
    let parent = &root.entries[0];

    fs::remove_file(fixture.root.join("ProjectA/src/one.md")).expect("delete fixture");
    let mut rules = fixture.state.scan_rules.get().expect("rules");
    rules.custom_exclusions = vec![
        fixture
            .root
            .join("ProjectA/src")
            .to_string_lossy()
            .to_string(),
    ];
    fixture
        .state
        .scan_rules
        .save(rules)
        .expect("save exclusion");

    let selected = resolve_workspace_selection(
        &fixture.state,
        WorkspaceSelectionInput {
            query_id: root.query_id,
            file_ids: vec![],
            directory_ids: vec![parent.id.clone()],
        },
    )
    .expect("safe empty selection");
    assert!(selected.file_ids.is_empty());
    assert_eq!(selected.file_count, 0);
}

#[test]
fn unknown_and_expired_queries_are_rejected() {
    let fixture = fixture();
    assert!(expand_workspace_query(&fixture.state, "missing", "missing", 0).is_err());

    let store = WorkspaceQueryStore::with_limits(8, Duration::from_millis(20));
    let state = AppState {
        workspace_queries: store,
        ..fixture.state.clone()
    };
    let page = query_workspace(&state, query_input()).expect("create expiring query");
    std::thread::sleep(Duration::from_millis(30));
    assert!(expand_workspace_query(&state, &page.query_id, "missing", 0).is_err());
}

#[test]
fn opening_paths_never_requires_a_visible_scan_root_node() {
    let fixture = fixture();
    let root = query_workspace(&fixture.state, query_input()).expect("root query");
    assert!(
        root.entries
            .iter()
            .all(|entry| Path::new(&entry.canonical_path) != fixture.root)
    );
}

#[test]
fn folded_documents_are_discovered_for_value_evaluation() {
    let fixture = fixture();
    let root = query_workspace(&fixture.state, query_input()).expect("root query");
    assert_eq!(
        root.entries.len(),
        1,
        "documents are folded into a directory"
    );

    let candidates = workspace_evaluation_candidate_ids(&fixture.state, &root.query_id)
        .expect("evaluation candidates");
    assert_eq!(candidates.len(), 3);
}
