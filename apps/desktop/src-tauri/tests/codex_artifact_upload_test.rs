use std::{
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    codex::{
        ArtifactUploadError, ArtifactUploadRequest, ArtifactUploader, CodexArtifactUploadService,
        CodexProjectFiles,
    },
    contracts::CodexArtifactInput,
    database::Database,
    ragflow::client::RagflowUpload,
};

struct FakeUploader {
    result: Mutex<Option<Result<RagflowUpload, ArtifactUploadError>>>,
    mutate_path: Mutex<Option<std::path::PathBuf>>,
    observed: Mutex<Option<(std::path::PathBuf, Vec<u8>)>>,
}

impl ArtifactUploader for FakeUploader {
    fn upload_document(
        &self,
        file_path: &std::path::Path,
        _dataset_id: &str,
        _parent_path: Option<&str>,
        _start_parsing: bool,
    ) -> Result<RagflowUpload, ArtifactUploadError> {
        if let Some(path) = self.mutate_path.lock().unwrap().take() {
            std::fs::write(path, "changed-during-upload").unwrap();
        }
        *self.observed.lock().unwrap() =
            Some((file_path.to_path_buf(), std::fs::read(file_path).unwrap()));
        self.result.lock().unwrap().take().unwrap()
    }
}

fn fixture(
    response: Result<RagflowUpload, ArtifactUploadError>,
) -> (
    std::path::PathBuf,
    Database,
    CodexProjectFiles,
    qizhi_desktop_lib::contracts::CodexArtifact,
    CodexArtifactUploadService,
    Arc<FakeUploader>,
) {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("qizhi-artifact-upload-{nonce}"));
    std::fs::create_dir_all(&root).unwrap();
    let database = Database::open(&root.join("qizhi.db")).unwrap();
    let files = CodexProjectFiles::new(root.join("projects"));
    let project = database
        .codex()
        .create_project("项目", None, "managed", 1)
        .unwrap();
    let layout = files.create_layout(&project.id).unwrap();
    std::fs::write(layout.workspace.join("report.md"), "report").unwrap();
    database
        .codex()
        .record_artifact(&CodexArtifactInput {
            project_id: project.id.clone(),
            relative_path: "report.md".to_owned(),
            content_hash: sha256(b"report"),
            size_bytes: 6,
            mime_type: "text/markdown".to_owned(),
            created_by_conversation_id: None,
            created_by_turn_id: None,
            detected_at_utc_ms: 2,
        })
        .unwrap();
    let artifact = database.codex().list_artifacts(&project.id).unwrap()[0].clone();
    let uploader = Arc::new(FakeUploader {
        result: Mutex::new(Some(response)),
        mutate_path: Mutex::new(None),
        observed: Mutex::new(None),
    });
    let service =
        CodexArtifactUploadService::new(database.clone(), files.clone(), uploader.clone());
    (root, database, files, artifact, service, uploader)
}

#[test]
fn uploads_a_verified_artifact_and_records_document_ids() {
    let (root, database, _files, artifact, service, _uploader) = fixture(Ok(RagflowUpload {
        document_ids: vec!["doc-1".to_owned()],
        document_count: 1,
        parsing_started: true,
        parsing_error: None,
    }));
    let result = service
        .upload(
            ArtifactUploadRequest {
                artifact_id: artifact.id.clone(),
                dataset_id: "dataset-1".to_owned(),
                parent_path: Some("reports".to_owned()),
                start_parsing: true,
                confirm_duplicate: false,
            },
            false,
        )
        .unwrap();
    assert_eq!(result.status, "uploaded");
    assert_eq!(result.document_ids_json.as_deref(), Some(r#"["doc-1"]"#));
    assert_eq!(
        database
            .codex()
            .list_artifact_uploads(&artifact.id)
            .unwrap()
            .len(),
        1
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn rejects_changed_bytes_and_does_not_call_the_uploader() {
    let (root, database, files, artifact, service, _uploader) = fixture(Ok(RagflowUpload {
        document_ids: vec!["unexpected".to_owned()],
        document_count: 1,
        parsing_started: false,
        parsing_error: None,
    }));
    let path = files
        .resolve_workspace_path(&artifact.project_id, std::path::Path::new("report.md"))
        .unwrap();
    std::fs::write(path, "changed").unwrap();
    assert_eq!(
        service
            .upload(
                ArtifactUploadRequest {
                    artifact_id: artifact.id.clone(),
                    dataset_id: "dataset-1".to_owned(),
                    parent_path: None,
                    start_parsing: false,
                    confirm_duplicate: false,
                },
                false,
            )
            .unwrap_err(),
        ArtifactUploadError::SourceChanged
    );
    assert!(
        database
            .codex()
            .list_artifact_uploads(&artifact.id)
            .unwrap()
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn records_uncertain_delivery_without_automatic_retry() {
    let (root, database, _files, artifact, service, _uploader) =
        fixture(Err(ArtifactUploadError::Uncertain));
    assert_eq!(
        service
            .upload(
                ArtifactUploadRequest {
                    artifact_id: artifact.id.clone(),
                    dataset_id: "dataset-1".to_owned(),
                    parent_path: None,
                    start_parsing: false,
                    confirm_duplicate: false,
                },
                false,
            )
            .unwrap_err(),
        ArtifactUploadError::Uncertain
    );
    assert_eq!(
        database
            .codex()
            .list_artifact_uploads(&artifact.id)
            .unwrap()[0]
            .status,
        "uncertain"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn uploads_an_immutable_snapshot_even_if_the_workspace_file_changes_during_delivery() {
    let (root, _database, files, artifact, service, uploader) = fixture(Ok(RagflowUpload {
        document_ids: vec!["doc-snapshot".to_owned()],
        document_count: 1,
        parsing_started: false,
        parsing_error: None,
    }));
    let workspace_path = files
        .resolve_workspace_path(&artifact.project_id, std::path::Path::new("report.md"))
        .unwrap();
    *uploader.mutate_path.lock().unwrap() = Some(workspace_path.clone());

    service
        .upload(
            ArtifactUploadRequest {
                artifact_id: artifact.id,
                dataset_id: "dataset-1".to_owned(),
                parent_path: None,
                start_parsing: false,
                confirm_duplicate: false,
            },
            false,
        )
        .unwrap();

    let (uploaded_path, uploaded_bytes) = uploader.observed.lock().unwrap().clone().unwrap();
    assert_ne!(uploaded_path, workspace_path);
    assert_eq!(uploaded_bytes, b"report");
    let _ = std::fs::remove_dir_all(root);
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
