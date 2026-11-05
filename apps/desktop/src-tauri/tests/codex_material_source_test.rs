use std::{
    fs,
    io::Read,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    app_state::AppState,
    codex::{
        CodexHandoffPreparationStore, CodexHandoffService, CodexProjectFiles, CodexRuntime,
        MaterialImportStatus,
    },
    commands::codex::{
        inspect_codex_material_sources_with_state, refresh_codex_material_with_state,
        remove_codex_material_with_state,
    },
    contracts::CodexMaterialVersionInput,
    database::Database,
    knowledge_selection::KnowledgeSelectionStore,
    scan::{
        configuration::{ScanRuleStore, ScanRules},
        file_filter::FileCategory,
        progress::TodayScanProgress,
    },
    telemetry::AppLogger,
    today_workspace::WorkspaceQueryStore,
};
use sha2::{Digest, Sha256};

struct Fixture {
    root: PathBuf,
    state: AppState,
    project_id: String,
    source: PathBuf,
    material_id: String,
    first_version_id: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("qizhi-material-source-{nonce}"));
        let sources = root.join("sources");
        fs::create_dir_all(&sources).unwrap();
        let source = sources.join("report.md");
        fs::write(&source, "first version").unwrap();
        let database = Database::open(&root.join("qizhi.db")).unwrap();
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
        let project_files = CodexProjectFiles::new(root.join("projects"));
        let handoffs = CodexHandoffService::new(
            database.clone(),
            project_files.clone(),
            queries.clone(),
            rules.clone(),
            CodexHandoffPreparationStore::new(),
        );
        let runtime = CodexRuntime::new(database.clone(), project_files.clone());
        let project = database
            .codex()
            .create_project("资料项目", None, "managed", 100)
            .unwrap();
        let imported = project_files
            .snapshot_local_files(&project.id, std::slice::from_ref(&source))
            .unwrap()
            .remove(0);
        assert_eq!(imported.status, MaterialImportStatus::Imported);
        let layout = project_files.create_layout(&project.id).unwrap();
        let material = database
            .codex()
            .create_material(
                &project.id,
                "local",
                "report.md",
                Some(&source.to_string_lossy()),
                110,
            )
            .unwrap();
        let first_version = database
            .codex()
            .record_material_version(&CodexMaterialVersionInput {
                material_id: material.id.clone(),
                original_snapshot_path: imported
                    .original_snapshot_path
                    .unwrap()
                    .strip_prefix(&layout.root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                derived_snapshot_path: imported.derived_snapshot_path.map(|path| {
                    path.strip_prefix(&layout.root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                }),
                content_hash: imported.content_hash.unwrap(),
                size_bytes: imported.size_bytes as i64,
                mime_type: "text/markdown".to_owned(),
                extractor_version: Some("qizhi-1".to_owned()),
                created_at_utc_ms: 111,
            })
            .unwrap();
        let state = AppState {
            database,
            scan_rules: rules,
            today_scan_progress: TodayScanProgress::new(),
            logger: AppLogger::new(&root),
            workspace_queries: queries,
            codex_runtime: runtime,
            codex_handoffs: handoffs,
            knowledge_selections: KnowledgeSelectionStore::default(),
        };
        Self {
            root,
            state,
            project_id: project.id,
            source,
            material_id: material.id,
            first_version_id: first_version.id,
        }
    }
}

#[test]
fn inspects_refreshes_reuses_and_removes_local_material_versions() {
    let fixture = Fixture::new();
    assert_eq!(
        inspect_codex_material_sources_with_state(&fixture.project_id, &fixture.state).unwrap()[0]
            .state,
        "ready"
    );

    fs::write(&fixture.source, "second version").unwrap();
    assert_eq!(
        inspect_codex_material_sources_with_state(&fixture.project_id, &fixture.state).unwrap()[0]
            .state,
        "source_changed"
    );
    let refreshed = refresh_codex_material_with_state(
        &fixture.project_id,
        &fixture.material_id,
        &fixture.state,
    )
    .unwrap();
    let second_version_id = refreshed[0].current_version_id.clone().unwrap();
    assert_ne!(second_version_id, fixture.first_version_id);
    assert!(
        fixture
            .state
            .database
            .codex()
            .get_material_version(&fixture.first_version_id)
            .unwrap()
            .is_some()
    );

    fs::write(&fixture.source, "first version").unwrap();
    let rolled_back = refresh_codex_material_with_state(
        &fixture.project_id,
        &fixture.material_id,
        &fixture.state,
    )
    .unwrap();
    let rollback_version_id = rolled_back[0].current_version_id.clone().unwrap();
    assert_ne!(rollback_version_id, second_version_id);
    let rollback_version = fixture
        .state
        .database
        .codex()
        .get_material_version(&rollback_version_id)
        .unwrap()
        .unwrap();
    let first_version = fixture
        .state
        .database
        .codex()
        .get_material_version(&fixture.first_version_id)
        .unwrap()
        .unwrap();
    assert_eq!(rollback_version.content_hash, first_version.content_hash);
    assert_eq!(
        rollback_version.original_snapshot_path,
        first_version.original_snapshot_path
    );

    let remaining =
        remove_codex_material_with_state(&fixture.project_id, &fixture.material_id, &fixture.state)
            .unwrap();
    assert!(remaining.is_empty());
}

#[test]
fn reports_missing_snapshot_only_original_only_and_busy_states() {
    let fixture = Fixture::new();
    let lease = fixture
        .state
        .codex_runtime
        .reserve_project_mutation(&fixture.project_id)
        .unwrap();
    assert!(
        refresh_codex_material_with_state(
            &fixture.project_id,
            &fixture.material_id,
            &fixture.state,
        )
        .is_err()
    );
    assert!(
        remove_codex_material_with_state(
            &fixture.project_id,
            &fixture.material_id,
            &fixture.state,
        )
        .is_err()
    );
    drop(lease);

    let chunk = fixture
        .state
        .database
        .codex()
        .create_material_with_metadata(
            &fixture.project_id,
            "ragflow_chunk",
            "检索片段.md",
            Some("ragflow:chunk:1"),
            Some(r#"{"chunkId":"1"}"#),
            130,
        )
        .unwrap();
    let docx = fixture.root.join("sources").join("original-only.docx");
    fs::write(&docx, b"not-a-real-archive").unwrap();
    let docx_material = fixture
        .state
        .database
        .codex()
        .create_material(
            &fixture.project_id,
            "local",
            "original-only.docx",
            Some(&docx.to_string_lossy()),
            131,
        )
        .unwrap();
    fixture
        .state
        .database
        .codex()
        .record_material_version(&CodexMaterialVersionInput {
            material_id: docx_material.id.clone(),
            original_snapshot_path: "materials/local/original-only.docx".to_owned(),
            derived_snapshot_path: None,
            content_hash: sha256(&docx),
            size_bytes: fs::metadata(&docx).unwrap().len() as i64,
            mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                .to_owned(),
            extractor_version: Some("qizhi-1".to_owned()),
            created_at_utc_ms: 132,
        })
        .unwrap();

    let statuses =
        inspect_codex_material_sources_with_state(&fixture.project_id, &fixture.state).unwrap();
    assert_eq!(
        statuses
            .iter()
            .find(|status| status.material_id == chunk.id)
            .unwrap()
            .state,
        "snapshot_only"
    );
    assert_eq!(
        statuses
            .iter()
            .find(|status| status.material_id == docx_material.id)
            .unwrap()
            .state,
        "original_only"
    );

    fs::write(&docx, b"still-not-a-real-archive-but-updated").unwrap();
    let refreshed_original_only =
        refresh_codex_material_with_state(&fixture.project_id, &docx_material.id, &fixture.state)
            .unwrap();
    let refreshed_original_only = refreshed_original_only
        .iter()
        .find(|material| material.id == docx_material.id)
        .unwrap();
    let refreshed_version = fixture
        .state
        .database
        .codex()
        .get_material_version(
            refreshed_original_only
                .current_version_id
                .as_deref()
                .unwrap(),
        )
        .unwrap()
        .unwrap();
    assert!(refreshed_version.derived_snapshot_path.is_none());

    fs::remove_file(&fixture.source).unwrap();
    assert_eq!(
        inspect_codex_material_sources_with_state(&fixture.project_id, &fixture.state)
            .unwrap()
            .iter()
            .find(|status| status.material_id == fixture.material_id)
            .unwrap()
            .state,
        "source_missing"
    );
}

fn sha256(path: &PathBuf) -> String {
    let mut file = fs::File::open(path).unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    format!("{:x}", Sha256::digest(bytes))
}
