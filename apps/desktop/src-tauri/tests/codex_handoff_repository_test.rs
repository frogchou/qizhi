use std::time::{SystemTime, UNIX_EPOCH};

use qizhi_desktop_lib::{
    contracts::{
        CodexArtifactInput, CodexArtifactUploadInput, CodexHandoffItemInput,
        CodexMaterialVersionInput,
    },
    database::Database,
    database::repositories::codex_repository::CommitHandoffMaterialInput,
};

fn temporary_database(name: &str) -> (std::path::PathBuf, Database) {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("qizhi-handoff-{name}-{nonce}.sqlite"));
    let database = Database::open(&path).expect("database opens");
    (path, database)
}

#[test]
fn request_ids_are_unique_and_conversations_must_belong_to_the_project() {
    let (path, database) = temporary_database("ownership");
    let repository = database.codex();
    let first_project = repository
        .create_project("甲项目", None, "codex-projects/a", 100)
        .unwrap();
    let second_project = repository
        .create_project("乙项目", None, "codex-projects/b", 101)
        .unwrap();
    let first_conversation = repository
        .create_conversation(&first_project.id, "甲会话", 110)
        .unwrap();
    let second_conversation = repository
        .create_conversation(&second_project.id, "乙会话", 111)
        .unwrap();

    assert!(
        repository
            .create_handoff(
                "request-wrong-owner",
                "today",
                &first_project.id,
                &second_conversation.id,
                120,
            )
            .is_err()
    );

    let handoff = repository
        .create_handoff(
            "request-1",
            "today",
            &first_project.id,
            &first_conversation.id,
            121,
        )
        .expect("valid handoff");
    assert_eq!(handoff.status, "preparing");
    assert!(
        repository
            .create_handoff(
                "request-1",
                "recent",
                &first_project.id,
                &first_conversation.id,
                122,
            )
            .is_err()
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn ready_handoffs_are_isolated_by_conversation_and_consumed_with_the_turn() {
    let (path, database) = temporary_database("states");
    let repository = database.codex();
    let project = repository
        .create_project("项目", None, "codex-projects/states", 100)
        .unwrap();
    let other_project = repository
        .create_project("其他项目", None, "codex-projects/other", 101)
        .unwrap();
    let conversation = repository
        .create_conversation(&project.id, "当前会话", 110)
        .unwrap();
    let other_conversation = repository
        .create_conversation(&project.id, "另一个会话", 111)
        .unwrap();

    let material = repository
        .create_material(&project.id, "local", "方案.docx", Some("source-a"), 120)
        .unwrap();
    let first_version = repository
        .record_material_version(&CodexMaterialVersionInput {
            material_id: material.id.clone(),
            original_snapshot_path: "materials/a.docx".to_owned(),
            derived_snapshot_path: Some("materials/a.md".to_owned()),
            content_hash: "hash-a".to_owned(),
            size_bytes: 20,
            mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                .to_owned(),
            extractor_version: Some("extractor-1".to_owned()),
            created_at_utc_ms: 121,
        })
        .unwrap();
    let second_material = repository
        .create_material(&project.id, "local", "附件.txt", Some("source-b"), 122)
        .unwrap();
    let second_version = repository
        .record_material_version(&CodexMaterialVersionInput {
            material_id: second_material.id.clone(),
            original_snapshot_path: "materials/b.txt".to_owned(),
            derived_snapshot_path: None,
            content_hash: "hash-b".to_owned(),
            size_bytes: 8,
            mime_type: "text/plain".to_owned(),
            extractor_version: None,
            created_at_utc_ms: 123,
        })
        .unwrap();
    let foreign_material = repository
        .create_material(&other_project.id, "local", "越界.txt", Some("foreign"), 124)
        .unwrap();
    let foreign_version = repository
        .record_material_version(&CodexMaterialVersionInput {
            material_id: foreign_material.id.clone(),
            original_snapshot_path: "materials/foreign.txt".to_owned(),
            derived_snapshot_path: None,
            content_hash: "hash-foreign".to_owned(),
            size_bytes: 1,
            mime_type: "text/plain".to_owned(),
            extractor_version: None,
            created_at_utc_ms: 125,
        })
        .unwrap();

    let rejected = repository
        .create_handoff(
            "request-rejected",
            "today",
            &project.id,
            &conversation.id,
            130,
        )
        .unwrap();
    assert!(
        repository
            .mark_handoff_ready(
                &rejected.id,
                &[CodexHandoffItemInput {
                    material_id: foreign_material.id,
                    material_version_id: foreign_version.id,
                    display_name: "越界.txt".to_owned(),
                    source_metadata_json: "{}".to_owned(),
                    display_order: 0,
                }],
            )
            .is_err()
    );

    let handoff = repository
        .create_handoff("request-ready", "today", &project.id, &conversation.id, 131)
        .unwrap();
    let details = repository
        .mark_handoff_ready(
            &handoff.id,
            &[
                CodexHandoffItemInput {
                    material_id: material.id.clone(),
                    material_version_id: first_version.id,
                    display_name: "方案.docx".to_owned(),
                    source_metadata_json: r#"{"fileId":"file-a"}"#.to_owned(),
                    display_order: 0,
                },
                CodexHandoffItemInput {
                    material_id: second_material.id.clone(),
                    material_version_id: second_version.id,
                    display_name: "附件.txt".to_owned(),
                    source_metadata_json: r#"{"fileId":"file-b"}"#.to_owned(),
                    display_order: 1,
                },
            ],
        )
        .expect("handoff becomes ready");
    assert_eq!(details.items.len(), 2);
    assert_eq!(
        repository
            .list_pending_handoffs(&conversation.id)
            .unwrap()
            .len(),
        1
    );
    assert!(
        repository
            .list_pending_handoffs(&other_conversation.id)
            .unwrap()
            .is_empty()
    );

    repository
        .dismiss_handoff_item(&handoff.id, &material.id)
        .expect("one item dismissed");
    let turn = repository
        .create_turn(&conversation.id, "使用附件完成任务", 140)
        .unwrap();
    repository
        .consume_handoffs(&turn.id, &conversation.id, &[handoff.id.clone()], 141)
        .expect("handoff consumed");

    let consumed = repository
        .find_handoff_by_request("request-ready")
        .unwrap()
        .expect("handoff remains queryable");
    assert_eq!(consumed.handoff.status, "consumed");
    assert_eq!(consumed.items[0].state, "dismissed");
    assert_eq!(consumed.items[1].state, "consumed");
    assert_eq!(
        repository.list_turn_handoffs(&turn.id).unwrap(),
        vec![handoff.id]
    );
    assert!(
        repository
            .list_pending_handoffs(&conversation.id)
            .unwrap()
            .is_empty()
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn artifact_upload_states_round_trip_and_reject_unknown_states() {
    let (path, database) = temporary_database("uploads");
    let repository = database.codex();
    let project = repository
        .create_project("项目", None, "codex-projects/uploads", 100)
        .unwrap();
    repository
        .record_artifact(&CodexArtifactInput {
            project_id: project.id.clone(),
            relative_path: "outputs/report.md".to_owned(),
            content_hash: "artifact-hash".to_owned(),
            size_bytes: 42,
            mime_type: "text/markdown".to_owned(),
            created_by_conversation_id: None,
            created_by_turn_id: None,
            detected_at_utc_ms: 110,
        })
        .unwrap();
    let artifact = repository.list_artifacts(&project.id).unwrap().remove(0);

    let upload = repository
        .record_artifact_upload(&CodexArtifactUploadInput {
            artifact_id: artifact.id.clone(),
            dataset_id: "dataset-a".to_owned(),
            parent_path: Some("weekly".to_owned()),
            content_hash: artifact.content_hash.clone(),
            document_ids_json: Some(r#"["doc-a"]"#.to_owned()),
            status: "uploaded".to_owned(),
            start_parsing: true,
            created_at_utc_ms: 120,
            completed_at_utc_ms: Some(121),
            error_summary: None,
        })
        .expect("uploaded state is stored");
    assert_eq!(upload.status, "uploaded");
    assert_eq!(
        repository.list_artifact_uploads(&artifact.id).unwrap()[0]
            .document_ids_json
            .as_deref(),
        Some(r#"["doc-a"]"#)
    );
    assert!(
        repository
            .record_artifact_upload(&CodexArtifactUploadInput {
                artifact_id: artifact.id,
                dataset_id: "dataset-a".to_owned(),
                parent_path: None,
                content_hash: "artifact-hash".to_owned(),
                document_ids_json: None,
                status: "maybe".to_owned(),
                start_parsing: false,
                created_at_utc_ms: 122,
                completed_at_utc_ms: None,
                error_summary: None,
            })
            .is_err()
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn interrupted_preparing_handoffs_are_recovered_as_failed() {
    let (path, database) = temporary_database("recovery");
    let repository = database.codex();
    let project = repository
        .create_project("项目", None, "codex-projects/recovery", 100)
        .unwrap();
    let conversation = repository
        .create_conversation(&project.id, "会话", 110)
        .unwrap();
    repository
        .create_handoff(
            "request-preparing",
            "ragflow_document",
            &project.id,
            &conversation.id,
            120,
        )
        .unwrap();

    assert_eq!(repository.recover_interrupted_handoffs(130).unwrap(), 1);
    let recovered = repository
        .find_handoff_by_request("request-preparing")
        .unwrap()
        .unwrap();
    assert_eq!(recovered.handoff.status, "failed");
    assert_eq!(
        recovered.handoff.error_summary.as_deref(),
        Some("应用重启，资料交接未完成")
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn reusing_an_identical_removed_material_restores_it_to_the_project() {
    let (path, database) = temporary_database("restore-removed");
    let repository = database.codex();
    let project = repository
        .create_project("项目", None, "codex-projects/restore", 100)
        .unwrap();
    let conversation = repository
        .create_conversation(&project.id, "会话", 110)
        .unwrap();
    let material = repository
        .create_material(&project.id, "local", "方案.md", Some("file:7"), 120)
        .unwrap();
    repository
        .record_material_version(&CodexMaterialVersionInput {
            material_id: material.id.clone(),
            original_snapshot_path: "materials/方案.md".to_owned(),
            derived_snapshot_path: None,
            content_hash: "same-hash".to_owned(),
            size_bytes: 8,
            mime_type: "text/markdown".to_owned(),
            extractor_version: Some("qizhi-1".to_owned()),
            created_at_utc_ms: 121,
        })
        .unwrap();
    repository
        .set_material_state(&material.id, "removed")
        .unwrap();
    assert!(repository.list_materials(&project.id).unwrap().is_empty());

    let handoff = repository
        .create_handoff(
            "request-restore",
            "today",
            &project.id,
            &conversation.id,
            130,
        )
        .unwrap();
    let reused = repository
        .commit_handoff_materials(
            &handoff.id,
            &project.id,
            &[CommitHandoffMaterialInput {
                kind: "local".to_owned(),
                display_name: "方案.md".to_owned(),
                origin_reference: "file:7".to_owned(),
                source_metadata_json: r#"{"fileId":7}"#.to_owned(),
                original_snapshot_path: "materials/方案.md".to_owned(),
                derived_snapshot_path: None,
                content_hash: "same-hash".to_owned(),
                size_bytes: 8,
                mime_type: "text/markdown".to_owned(),
                extractor_version: "qizhi-1".to_owned(),
                created_at_utc_ms: 131,
                display_order: 0,
            }],
        )
        .unwrap();

    assert_eq!(reused, vec![true]);
    let restored = repository.list_materials(&project.id).unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].id, material.id);
    assert_eq!(restored[0].snapshot_state, "ready");

    drop(database);
    let _ = std::fs::remove_file(path);
}
