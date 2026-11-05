use std::time::{SystemTime, UNIX_EPOCH};

use qizhi_desktop_lib::{
    contracts::{
        CodexApprovalInput, CodexArtifactInput, CodexMaterialVersionInput, CodexProcessItemInput,
    },
    database::{AppError, Database},
};

fn temporary_database(name: &str) -> (std::path::PathBuf, Database) {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("qizhi-codex-{name}-{nonce}.sqlite"));
    let database = Database::open(&path).expect("database opens");
    (path, database)
}

#[test]
fn project_names_are_trimmed_and_empty_names_are_rejected() {
    let (path, database) = temporary_database("project-name");
    let repository = database.codex();

    let project = repository
        .create_project(
            "  年度经营分析  ",
            Some("  整理资料并生成报告  "),
            "codex-projects/project-a",
            100,
        )
        .expect("valid project is created");

    assert_eq!(project.name, "年度经营分析");
    assert_eq!(project.goal.as_deref(), Some("整理资料并生成报告"));
    assert!(matches!(
        repository.create_project("   ", None, "codex-projects/project-b", 101),
        Err(AppError::InvalidConfig)
    ));

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn managed_project_roots_are_unique_for_each_project() {
    let (path, database) = temporary_database("managed-project-roots");
    let repository = database.codex();

    let first = repository
        .create_project("第一个项目", None, "managed", 100)
        .expect("first managed project is created");
    let second = repository
        .create_project("第二个项目", None, "managed", 101)
        .expect("a second managed project must not collide with the first");

    assert_ne!(first.root_path, second.root_path);
    assert!(first.root_path.ends_with(&first.id));
    assert!(second.root_path.ends_with(&second.id));

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn active_projects_are_sorted_by_last_opened_and_archived_projects_are_hidden() {
    let (path, database) = temporary_database("project-order");
    let repository = database.codex();
    let older = repository
        .create_project("较早项目", None, "codex-projects/older", 100)
        .expect("older project");
    let newer = repository
        .create_project("最近项目", None, "codex-projects/newer", 200)
        .expect("newer project");

    repository
        .set_project_status(&newer.id, "archived", 300)
        .expect("archive project");
    let active = repository.list_projects(false).expect("active projects");
    let all = repository.list_projects(true).expect("all projects");

    assert_eq!(
        active
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        [&older.id]
    );
    assert_eq!(
        all.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
        [&newer.id, &older.id]
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn conversations_allow_duplicate_titles_and_persist_thread_mapping() {
    let (path, database) = temporary_database("conversation");
    let repository = database.codex();
    let project = repository
        .create_project("客户方案", None, "codex-projects/customer", 100)
        .expect("project");
    let first = repository
        .create_conversation(&project.id, "新会话", 110)
        .expect("first conversation");
    let second = repository
        .create_conversation(&project.id, "新会话", 120)
        .expect("second conversation");

    repository
        .attach_thread(&first.id, "thread-1", "session-1", 130)
        .expect("thread mapping");
    let conversations = repository
        .list_conversations(&project.id, false)
        .expect("conversations");

    assert_ne!(first.id, second.id);
    assert_eq!(conversations[0].id, first.id);
    assert_eq!(
        conversations[0].codex_thread_id.as_deref(),
        Some("thread-1")
    );
    assert_eq!(
        conversations[0].codex_session_id.as_deref(),
        Some("session-1")
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn visible_turn_history_round_trips_messages_and_process_items() {
    let (path, database) = temporary_database("history");
    let repository = database.codex();
    let project = repository
        .create_project("周报", None, "codex-projects/weekly", 100)
        .expect("project");
    let conversation = repository
        .create_conversation(&project.id, "整理周报", 110)
        .expect("conversation");
    let turn = repository
        .create_turn(&conversation.id, "请整理本周工作", 120)
        .expect("turn");

    repository
        .append_message(&turn.id, "user", "请整理本周工作", "completed", 121)
        .expect("user message");
    repository
        .append_message(&turn.id, "assistant", "已生成周报。", "completed", 122)
        .expect("assistant message");
    repository
        .upsert_process_item(&CodexProcessItemInput {
            turn_id: turn.id.clone(),
            codex_item_id: "item-1".to_owned(),
            kind: "command".to_owned(),
            title: "生成 Markdown".to_owned(),
            safe_summary: "已创建 weekly.md".to_owned(),
            status: "completed".to_owned(),
        })
        .expect("process item");

    let history = repository
        .read_conversation(&conversation.id)
        .expect("history reads");

    assert_eq!(history.turns.len(), 1);
    assert_eq!(history.turns[0].messages.len(), 2);
    assert_eq!(history.turns[0].messages[1].markdown, "已生成周报。");
    assert_eq!(
        history.turns[0].process_items[0].safe_summary,
        "已创建 weekly.md"
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn turn_material_versions_artifacts_approvals_and_preferences_round_trip() {
    let (path, database) = temporary_database("material-artifact");
    let repository = database.codex();
    let project = repository
        .create_project("资料分析", None, "codex-projects/research", 100)
        .expect("project");
    let conversation = repository
        .create_conversation(&project.id, "分析", 110)
        .expect("conversation");
    let turn = repository
        .create_turn(&conversation.id, "分析材料", 120)
        .expect("turn");
    let material = repository
        .create_material(&project.id, "local", "报告.docx", Some("source-1"), 121)
        .expect("material");
    let first_version = repository
        .record_material_version(&CodexMaterialVersionInput {
            material_id: material.id.clone(),
            original_snapshot_path: "materials/local/report-v1.docx".to_owned(),
            derived_snapshot_path: Some("materials/local/report-v1.md".to_owned()),
            content_hash: "hash-v1".to_owned(),
            size_bytes: 10,
            mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                .to_owned(),
            extractor_version: Some("extractor-1".to_owned()),
            created_at_utc_ms: 122,
        })
        .expect("first version");
    let second_version = repository
        .record_material_version(&CodexMaterialVersionInput {
            material_id: material.id.clone(),
            original_snapshot_path: "materials/local/report-v2.docx".to_owned(),
            derived_snapshot_path: Some("materials/local/report-v2.md".to_owned()),
            content_hash: "hash-v2".to_owned(),
            size_bytes: 20,
            mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                .to_owned(),
            extractor_version: Some("extractor-1".to_owned()),
            created_at_utc_ms: 123,
        })
        .expect("second version");
    repository
        .bind_turn_material_version(&turn.id, &first_version.id)
        .expect("bind first");
    repository
        .bind_turn_material_version(&turn.id, &second_version.id)
        .expect("bind second");
    repository
        .record_artifact(&CodexArtifactInput {
            project_id: project.id.clone(),
            relative_path: "weekly.md".to_owned(),
            content_hash: "artifact-hash".to_owned(),
            size_bytes: 30,
            mime_type: "text/markdown".to_owned(),
            created_by_conversation_id: Some(conversation.id.clone()),
            created_by_turn_id: Some(turn.id.clone()),
            detected_at_utc_ms: 124,
        })
        .expect("artifact");
    repository
        .record_approval(&CodexApprovalInput {
            project_id: project.id.clone(),
            conversation_id: conversation.id.clone(),
            turn_id: turn.id.clone(),
            item_id: "approval-1".to_owned(),
            action_type: "command".to_owned(),
            target_summary: "生成 weekly.md".to_owned(),
            decision: "accept".to_owned(),
            created_at_utc_ms: 125,
        })
        .expect("approval");
    repository
        .save_preferences("gpt-5.6-sol", "medium")
        .expect("preferences");

    assert_eq!(
        repository
            .list_turn_material_versions(&turn.id)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        repository.list_materials(&project.id).unwrap()[0]
            .current_version_id
            .as_deref(),
        Some(second_version.id.as_str())
    );
    assert_eq!(
        repository.list_artifacts(&project.id).unwrap()[0].relative_path,
        "weekly.md"
    );
    assert_eq!(
        repository.list_approvals(&turn.id).unwrap()[0].decision,
        "accept"
    );
    let preferences = repository.get_preferences().expect("preferences read");
    assert_eq!(preferences.model, "gpt-5.6-sol");
    assert_eq!(preferences.reasoning_effort, "medium");

    drop(database);
    let _ = std::fs::remove_file(path);
}
