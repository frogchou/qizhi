use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use crate::{
    contracts::{
        CodexApprovalInput, CodexApprovalRecord, CodexArtifact, CodexArtifactInput,
        CodexArtifactUpload, CodexArtifactUploadInput, CodexConversation, CodexConversationHistory,
        CodexHandoff, CodexHandoffDetails, CodexHandoffItem, CodexHandoffItemInput, CodexMaterial,
        CodexMaterialVersion, CodexMaterialVersionInput, CodexMessage, CodexPreferences,
        CodexProcessItem, CodexProcessItemInput, CodexProject, CodexTurnHistory,
        CodexTurnProjection,
    },
    database::{AppError, Database},
};

#[derive(Clone)]
pub struct CodexRepository {
    database: Database,
}

pub struct CommitHandoffMaterialInput {
    pub kind: String,
    pub origin_reference: String,
    pub display_name: String,
    pub source_metadata_json: String,
    pub original_snapshot_path: String,
    pub derived_snapshot_path: Option<String>,
    pub content_hash: String,
    pub size_bytes: i64,
    pub mime_type: String,
    pub extractor_version: String,
    pub created_at_utc_ms: i64,
    pub display_order: i64,
}

impl CodexRepository {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn create_project(
        &self,
        name: &str,
        goal: Option<&str>,
        root_path: &str,
        now: i64,
    ) -> Result<CodexProject, AppError> {
        let name = normalize_required(name)?;
        let requested_root_path = normalize_required(root_path)?;
        let goal = goal.map(str::trim).filter(|value| !value.is_empty());
        let id = Uuid::new_v4().to_string();
        let root_path = if requested_root_path == "managed" {
            format!("managed/{id}")
        } else {
            requested_root_path.to_owned()
        };
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO codex_projects(id,name,goal,root_path,status,created_at_utc_ms,updated_at_utc_ms,last_opened_at_utc_ms) VALUES (?1,?2,?3,?4,'active',?5,?5,?5)",
                params![id, name, goal, root_path, now],
            )?;
            transaction.query_row(
                "SELECT id,name,goal,root_path,status,created_at_utc_ms,updated_at_utc_ms,last_opened_at_utc_ms FROM codex_projects WHERE id=?1",
                [&id],
                map_project,
            )
        })
    }

    pub fn list_projects(&self, include_archived: bool) -> Result<Vec<CodexProject>, AppError> {
        self.database.with_connection(|connection| {
            let sql = if include_archived {
                "SELECT id,name,goal,root_path,status,created_at_utc_ms,updated_at_utc_ms,last_opened_at_utc_ms FROM codex_projects WHERE status != 'deleted' ORDER BY last_opened_at_utc_ms DESC,id"
            } else {
                "SELECT id,name,goal,root_path,status,created_at_utc_ms,updated_at_utc_ms,last_opened_at_utc_ms FROM codex_projects WHERE status = 'active' ORDER BY last_opened_at_utc_ms DESC,id"
            };
            let mut statement = connection.prepare(sql)?;
            statement.query_map([], map_project)?.collect()
        })
    }

    pub fn rename_project(&self, id: &str, name: &str, now: i64) -> Result<(), AppError> {
        let name = normalize_required(name)?;
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_projects SET name=?1,updated_at_utc_ms=?2 WHERE id=?3 AND status!='deleted'",
                params![name, now, id],
            )?)
        })
    }

    pub fn set_project_status(&self, id: &str, status: &str, now: i64) -> Result<(), AppError> {
        if !matches!(status, "active" | "archived" | "deleted") {
            return Err(AppError::InvalidConfig);
        }
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_projects SET status=?1,updated_at_utc_ms=?2 WHERE id=?3",
                params![status, now, id],
            )?)
        })
    }

    pub fn create_conversation(
        &self,
        project_id: &str,
        title: &str,
        now: i64,
    ) -> Result<CodexConversation, AppError> {
        let title = normalize_required(title)?;
        let id = Uuid::new_v4().to_string();
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO codex_conversations(id,project_id,title,status,created_at_utc_ms,updated_at_utc_ms) SELECT ?1,id,?2,'draft',?3,?3 FROM codex_projects WHERE id=?4 AND status='active'",
                params![id, title, now, project_id],
            )?;
            transaction.query_row(
                "SELECT id,project_id,title,codex_thread_id,codex_session_id,status,created_at_utc_ms,updated_at_utc_ms,archived_at_utc_ms FROM codex_conversations WHERE id=?1",
                [&id],
                map_conversation,
            )
        })
    }

    pub fn list_conversations(
        &self,
        project_id: &str,
        include_archived: bool,
    ) -> Result<Vec<CodexConversation>, AppError> {
        self.database.with_connection(|connection| {
            let sql = if include_archived {
                "SELECT id,project_id,title,codex_thread_id,codex_session_id,status,created_at_utc_ms,updated_at_utc_ms,archived_at_utc_ms FROM codex_conversations WHERE project_id=?1 ORDER BY updated_at_utc_ms DESC,id"
            } else {
                "SELECT id,project_id,title,codex_thread_id,codex_session_id,status,created_at_utc_ms,updated_at_utc_ms,archived_at_utc_ms FROM codex_conversations WHERE project_id=?1 AND status!='archived' ORDER BY updated_at_utc_ms DESC,id"
            };
            let mut statement = connection.prepare(sql)?;
            statement.query_map([project_id], map_conversation)?.collect()
        })
    }

    pub fn rename_conversation(&self, id: &str, title: &str, now: i64) -> Result<(), AppError> {
        let title = normalize_required(title)?;
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_conversations SET title=?1,updated_at_utc_ms=?2 WHERE id=?3 AND status!='archived'",
                params![title, now, id],
            )?)
        })
    }

    pub fn set_conversation_status(
        &self,
        id: &str,
        status: &str,
        now: i64,
    ) -> Result<(), AppError> {
        if !matches!(
            status,
            "draft" | "ready" | "running" | "interrupted" | "failed" | "unavailable" | "archived"
        ) {
            return Err(AppError::InvalidConfig);
        }
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_conversations SET status=?1,updated_at_utc_ms=?2,archived_at_utc_ms=CASE WHEN ?1='archived' THEN ?2 ELSE archived_at_utc_ms END WHERE id=?3",
                params![status, now, id],
            )?)
        })
    }

    pub fn attach_thread(
        &self,
        conversation_id: &str,
        thread_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<(), AppError> {
        let thread_id = normalize_required(thread_id)?;
        let session_id = normalize_required(session_id)?;
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_conversations SET codex_thread_id=?1,codex_session_id=?2,status='ready',updated_at_utc_ms=?3 WHERE id=?4 AND status!='archived'",
                params![thread_id, session_id, now, conversation_id],
            )?)
        })
    }

    pub fn create_turn(
        &self,
        conversation_id: &str,
        user_text: &str,
        now: i64,
    ) -> Result<CodexTurnProjection, AppError> {
        let user_text = normalize_required(user_text)?;
        let id = Uuid::new_v4().to_string();
        self.database.with_transaction(|transaction| {
            let inserted = transaction.execute(
                "INSERT INTO codex_turns(id,conversation_id,user_text,status,started_at_utc_ms) SELECT ?1,id,?2,'pending',?3 FROM codex_conversations WHERE id=?4 AND status!='archived'",
                params![id, user_text, now, conversation_id],
            )?;
            require_changed(inserted)?;
            transaction.execute(
                "UPDATE codex_conversations SET status='running',updated_at_utc_ms=?1 WHERE id=?2",
                params![now, conversation_id],
            )?;
            transaction.query_row(
                "SELECT id,conversation_id,codex_turn_id,user_text,status,started_at_utc_ms,completed_at_utc_ms,error_summary FROM codex_turns WHERE id=?1",
                [&id],
                map_turn,
            )
        })
    }

    pub fn append_message(
        &self,
        turn_id: &str,
        role: &str,
        markdown: &str,
        status: &str,
        now: i64,
    ) -> Result<CodexMessage, AppError> {
        if !matches!(role, "user" | "assistant")
            || !matches!(status, "streaming" | "completed" | "interrupted" | "failed")
        {
            return Err(AppError::InvalidConfig);
        }
        let id = Uuid::new_v4().to_string();
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO codex_messages(id,turn_id,role,markdown,status,created_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6)",
                params![id, turn_id, role, markdown, status, now],
            )?;
            transaction.query_row(
                "SELECT id,turn_id,role,markdown,status,created_at_utc_ms FROM codex_messages WHERE id=?1",
                [&id],
                map_message,
            )
        })
    }

    pub fn update_message(
        &self,
        message_id: &str,
        markdown: &str,
        status: &str,
    ) -> Result<(), AppError> {
        if !matches!(status, "streaming" | "completed" | "interrupted" | "failed") {
            return Err(AppError::InvalidConfig);
        }
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_messages SET markdown=?1,status=?2 WHERE id=?3",
                params![markdown, status, message_id],
            )?)
        })
    }

    pub fn attach_turn_id(&self, turn_id: &str, codex_turn_id: &str) -> Result<(), AppError> {
        let codex_turn_id = normalize_required(codex_turn_id)?;
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_turns SET codex_turn_id=?1,status='running' WHERE id=?2",
                params![codex_turn_id, turn_id],
            )?)
        })
    }

    pub fn upsert_process_item(&self, input: &CodexProcessItemInput) -> Result<(), AppError> {
        if input.turn_id.trim().is_empty() || input.codex_item_id.trim().is_empty() {
            return Err(AppError::InvalidConfig);
        }
        let id = Uuid::new_v4().to_string();
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO codex_process_items(id,turn_id,codex_item_id,kind,title,safe_summary,status) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(turn_id,codex_item_id) DO UPDATE SET kind=excluded.kind,title=excluded.title,safe_summary=excluded.safe_summary,status=excluded.status",
                params![id, input.turn_id, input.codex_item_id, input.kind, input.title, input.safe_summary, input.status],
            )?;
            Ok(())
        })
    }

    pub fn complete_turn(
        &self,
        turn_id: &str,
        status: &str,
        error_summary: Option<&str>,
        now: i64,
    ) -> Result<(), AppError> {
        if !matches!(status, "completed" | "interrupted" | "failed") {
            return Err(AppError::InvalidConfig);
        }
        self.database.with_transaction(|transaction| {
            let conversation_id: String = transaction.query_row(
                "SELECT conversation_id FROM codex_turns WHERE id=?1",
                [turn_id],
                |row| row.get(0),
            )?;
            require_changed(transaction.execute(
                "UPDATE codex_turns SET status=?1,completed_at_utc_ms=?2,error_summary=?3 WHERE id=?4",
                params![status, now, error_summary, turn_id],
            )?)?;
            let conversation_status = match status {
                "completed" => "ready",
                "failed" => "unavailable",
                other => other,
            };
            transaction.execute(
                "UPDATE codex_conversations SET status=?1,updated_at_utc_ms=?2 WHERE id=?3",
                params![conversation_status, now, conversation_id],
            )?;
            Ok(())
        })
    }

    pub fn read_conversation(&self, id: &str) -> Result<CodexConversationHistory, AppError> {
        self.database.with_connection(|connection| {
            let conversation = connection.query_row(
                "SELECT id,project_id,title,codex_thread_id,codex_session_id,status,created_at_utc_ms,updated_at_utc_ms,archived_at_utc_ms FROM codex_conversations WHERE id=?1",
                [id],
                map_conversation,
            )?;
            let mut turn_statement = connection.prepare(
                "SELECT id,conversation_id,codex_turn_id,user_text,status,started_at_utc_ms,completed_at_utc_ms,error_summary FROM codex_turns WHERE conversation_id=?1 ORDER BY started_at_utc_ms,id",
            )?;
            let turns = turn_statement
                .query_map([id], map_turn)?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(|turn| {
                    let mut message_statement = connection.prepare(
                        "SELECT id,turn_id,role,markdown,status,created_at_utc_ms FROM codex_messages WHERE turn_id=?1 ORDER BY created_at_utc_ms,id",
                    )?;
                    let messages = message_statement
                        .query_map([&turn.id], map_message)?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    let mut item_statement = connection.prepare(
                        "SELECT id,turn_id,codex_item_id,kind,title,safe_summary,status FROM codex_process_items WHERE turn_id=?1 ORDER BY rowid",
                    )?;
                    let process_items = item_statement
                        .query_map([&turn.id], map_process_item)?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    Ok(CodexTurnHistory {
                        turn,
                        messages,
                        process_items,
                    })
                })
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(CodexConversationHistory { conversation, turns })
        })
    }

    pub fn create_material(
        &self,
        project_id: &str,
        kind: &str,
        display_name: &str,
        origin_reference: Option<&str>,
        now: i64,
    ) -> Result<CodexMaterial, AppError> {
        self.create_material_with_metadata(
            project_id,
            kind,
            display_name,
            origin_reference,
            None,
            now,
        )
    }

    pub fn create_material_with_metadata(
        &self,
        project_id: &str,
        kind: &str,
        display_name: &str,
        origin_reference: Option<&str>,
        source_metadata_json: Option<&str>,
        now: i64,
    ) -> Result<CodexMaterial, AppError> {
        if !matches!(
            kind,
            "local" | "ragflow_chunk" | "ragflow_document" | "ragflow_answer"
        ) {
            return Err(AppError::InvalidConfig);
        }
        let display_name = normalize_required(display_name)?;
        if let Some(metadata) = source_metadata_json {
            serde_json::from_str::<serde_json::Value>(metadata)
                .map_err(|_| AppError::InvalidConfig)?;
        }
        let id = Uuid::new_v4().to_string();
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO codex_materials(id,project_id,kind,display_name,origin_reference,source_metadata_json,snapshot_state,imported_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6,'ready',?7)",
                params![id, project_id, kind, display_name, origin_reference, source_metadata_json, now],
            )?;
            transaction.query_row(
                "SELECT id,project_id,kind,display_name,origin_reference,source_metadata_json,current_version_id,snapshot_state,imported_at_utc_ms FROM codex_materials WHERE id=?1",
                [&id],
                map_material,
            )
        })
    }

    pub fn record_material_version(
        &self,
        input: &CodexMaterialVersionInput,
    ) -> Result<CodexMaterialVersion, AppError> {
        if input.size_bytes < 0 || input.original_snapshot_path.trim().is_empty() {
            return Err(AppError::InvalidConfig);
        }
        let id = Uuid::new_v4().to_string();
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO codex_material_versions(id,material_id,original_snapshot_path,derived_snapshot_path,content_hash,size_bytes,mime_type,extractor_version,created_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![id, input.material_id, input.original_snapshot_path, input.derived_snapshot_path, input.content_hash, input.size_bytes, input.mime_type, input.extractor_version, input.created_at_utc_ms],
            )?;
            transaction.execute(
                "UPDATE codex_materials SET current_version_id=?1,snapshot_state='ready' WHERE id=?2",
                params![id, input.material_id],
            )?;
            transaction.query_row(
                "SELECT id,material_id,original_snapshot_path,derived_snapshot_path,content_hash,size_bytes,mime_type,extractor_version,created_at_utc_ms FROM codex_material_versions WHERE id=?1",
                [&id],
                map_material_version,
            )
        })
    }

    pub fn bind_turn_material_version(
        &self,
        turn_id: &str,
        version_id: &str,
    ) -> Result<(), AppError> {
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "INSERT OR IGNORE INTO codex_turn_material_versions(turn_id,material_version_id) VALUES (?1,?2)",
                params![turn_id, version_id],
            )?;
            Ok(())
        })
    }

    pub fn list_turn_material_versions(
        &self,
        turn_id: &str,
    ) -> Result<Vec<CodexMaterialVersion>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT v.id,v.material_id,v.original_snapshot_path,v.derived_snapshot_path,v.content_hash,v.size_bytes,v.mime_type,v.extractor_version,v.created_at_utc_ms FROM codex_material_versions v JOIN codex_turn_material_versions tv ON tv.material_version_id=v.id WHERE tv.turn_id=?1 ORDER BY v.created_at_utc_ms,v.id",
            )?;
            statement.query_map([turn_id], map_material_version)?.collect()
        })
    }

    pub fn list_materials(&self, project_id: &str) -> Result<Vec<CodexMaterial>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,project_id,kind,display_name,origin_reference,source_metadata_json,current_version_id,snapshot_state,imported_at_utc_ms FROM codex_materials WHERE project_id=?1 AND snapshot_state!='removed' ORDER BY imported_at_utc_ms DESC,id",
            )?;
            statement.query_map([project_id], map_material)?.collect()
        })
    }

    pub fn find_material_by_origin_reference(
        &self,
        project_id: &str,
        origin_reference: &str,
    ) -> Result<Option<CodexMaterial>, AppError> {
        self.database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id,project_id,kind,display_name,origin_reference,source_metadata_json,current_version_id,snapshot_state,imported_at_utc_ms FROM codex_materials WHERE project_id=?1 AND origin_reference=?2 AND snapshot_state!='removed' ORDER BY imported_at_utc_ms DESC,id LIMIT 1",
                    params![project_id, origin_reference],
                    map_material,
                )
                .optional()
        })
    }

    pub fn get_material_version(
        &self,
        version_id: &str,
    ) -> Result<Option<CodexMaterialVersion>, AppError> {
        self.database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id,material_id,original_snapshot_path,derived_snapshot_path,content_hash,size_bytes,mime_type,extractor_version,created_at_utc_ms FROM codex_material_versions WHERE id=?1",
                    [version_id],
                    map_material_version,
                )
                .optional()
        })
    }

    pub fn find_project_material_version_by_hash(
        &self,
        project_id: &str,
        content_hash: &str,
    ) -> Result<Option<CodexMaterialVersion>, AppError> {
        self.database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT v.id,v.material_id,v.original_snapshot_path,v.derived_snapshot_path,v.content_hash,v.size_bytes,v.mime_type,v.extractor_version,v.created_at_utc_ms FROM codex_material_versions v JOIN codex_materials m ON m.id=v.material_id WHERE m.project_id=?1 AND v.content_hash=?2 ORDER BY v.created_at_utc_ms DESC,v.id LIMIT 1",
                    params![project_id, content_hash],
                    map_material_version,
                )
                .optional()
        })
    }

    pub fn project_has_active_turn(&self, project_id: &str) -> Result<bool, AppError> {
        self.database.with_connection(|connection| {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM codex_turns t JOIN codex_conversations c ON c.id=t.conversation_id WHERE c.project_id=?1 AND t.status IN ('pending','running'))",
                [project_id],
                |row| row.get(0),
            )
        })
    }

    pub fn create_handoff(
        &self,
        request_id: &str,
        source_kind: &str,
        project_id: &str,
        conversation_id: &str,
        now: i64,
    ) -> Result<CodexHandoff, AppError> {
        let request_id = normalize_required(request_id)?;
        if !matches!(
            source_kind,
            "today" | "recent" | "ragflow_chunks" | "ragflow_document" | "ragflow_answer"
        ) {
            return Err(AppError::InvalidConfig);
        }
        let id = Uuid::new_v4().to_string();
        self.database.with_transaction(|transaction| {
            let inserted = transaction.execute(
                "INSERT INTO codex_handoffs(id,request_id,source_kind,project_id,conversation_id,status,created_at_utc_ms) SELECT ?1,?2,?3,p.id,c.id,'preparing',?4 FROM codex_projects p JOIN codex_conversations c ON c.project_id=p.id WHERE p.id=?5 AND c.id=?6 AND p.status='active' AND c.status!='archived'",
                params![id, request_id, source_kind, now, project_id, conversation_id],
            )?;
            require_changed(inserted)?;
            transaction.query_row(
                "SELECT id,request_id,source_kind,project_id,conversation_id,status,created_at_utc_ms,consumed_at_utc_ms,error_summary FROM codex_handoffs WHERE id=?1",
                [&id],
                map_handoff,
            )
        })
    }

    pub fn mark_handoff_ready(
        &self,
        handoff_id: &str,
        items: &[CodexHandoffItemInput],
    ) -> Result<CodexHandoffDetails, AppError> {
        if items.is_empty()
            || items.iter().any(|item| {
                item.display_order < 0
                    || item.display_name.trim().is_empty()
                    || serde_json::from_str::<serde_json::Value>(&item.source_metadata_json)
                        .is_err()
            })
        {
            return Err(AppError::InvalidConfig);
        }
        self.database.with_transaction(|transaction| {
            let (project_id, status): (String, String) = transaction.query_row(
                "SELECT project_id,status FROM codex_handoffs WHERE id=?1",
                [handoff_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if status != "preparing" {
                return Err(rusqlite::Error::InvalidQuery);
            }
            for item in items {
                let belongs: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM codex_materials m JOIN codex_material_versions v ON v.material_id=m.id WHERE m.id=?1 AND v.id=?2 AND m.project_id=?3)",
                    params![item.material_id, item.material_version_id, project_id],
                    |row| row.get(0),
                )?;
                if !belongs {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                let item_id = Uuid::new_v4().to_string();
                transaction.execute(
                    "INSERT INTO codex_handoff_items(id,handoff_id,material_id,material_version_id,display_name,source_metadata_json,display_order,state) VALUES (?1,?2,?3,?4,?5,?6,?7,'ready')",
                    params![item_id, handoff_id, item.material_id, item.material_version_id, item.display_name.trim(), item.source_metadata_json, item.display_order],
                )?;
                transaction.execute(
                    "UPDATE codex_materials SET current_version_id=?1,snapshot_state='ready' WHERE id=?2",
                    params![item.material_version_id, item.material_id],
                )?;
            }
            require_changed(transaction.execute(
                "UPDATE codex_handoffs SET status='ready',error_summary=NULL WHERE id=?1 AND status='preparing'",
                [handoff_id],
            )?)
        })?;
        self.find_handoff_by_id(handoff_id)?
            .ok_or(AppError::Storage)
    }

    pub fn commit_handoff_materials(
        &self,
        handoff_id: &str,
        project_id: &str,
        inputs: &[CommitHandoffMaterialInput],
    ) -> Result<Vec<bool>, AppError> {
        if inputs.is_empty()
            || inputs.iter().any(|input| {
                input.display_name.trim().is_empty()
                    || !matches!(
                        input.kind.as_str(),
                        "local" | "ragflow_chunk" | "ragflow_document" | "ragflow_answer"
                    )
                    || input.origin_reference.trim().is_empty()
                    || input.original_snapshot_path.trim().is_empty()
                    || input.size_bytes < 0
                    || input.display_order < 0
                    || serde_json::from_str::<serde_json::Value>(&input.source_metadata_json)
                        .is_err()
            })
        {
            return Err(AppError::InvalidConfig);
        }
        self.database.with_transaction(|transaction| {
            let status: String = transaction.query_row(
                "SELECT status FROM codex_handoffs WHERE id=?1 AND project_id=?2",
                params![handoff_id, project_id],
                |row| row.get(0),
            )?;
            if status != "preparing" {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let mut reused = Vec::with_capacity(inputs.len());
            for input in inputs {
                let existing: Option<(String, Option<String>, Option<String>)> = transaction
                    .query_row(
                        "SELECT m.id,m.current_version_id,v.content_hash FROM codex_materials m LEFT JOIN codex_material_versions v ON v.id=m.current_version_id WHERE m.project_id=?1 AND m.origin_reference=?2",
                        params![project_id, input.origin_reference],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                let (material_id, version_id, reused_existing) = match existing {
                    Some((material_id, Some(version_id), Some(hash)))
                        if hash == input.content_hash =>
                    {
                        transaction.execute(
                            "UPDATE codex_materials SET snapshot_state='ready',display_name=?1,source_metadata_json=?2 WHERE id=?3",
                            params![input.display_name.trim(), input.source_metadata_json, material_id],
                        )?;
                        (material_id, version_id, true)
                    }
                    existing => {
                        let material_id = if let Some((material_id, _, _)) = existing {
                            material_id
                        } else {
                            let material_id = Uuid::new_v4().to_string();
                            transaction.execute(
                                "INSERT INTO codex_materials(id,project_id,kind,display_name,origin_reference,source_metadata_json,snapshot_state,imported_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6,'ready',?7)",
                                params![material_id, project_id, input.kind, input.display_name.trim(), input.origin_reference, input.source_metadata_json, input.created_at_utc_ms],
                            )?;
                            material_id
                        };
                        let version_id = Uuid::new_v4().to_string();
                        transaction.execute(
                            "INSERT INTO codex_material_versions(id,material_id,original_snapshot_path,derived_snapshot_path,content_hash,size_bytes,mime_type,extractor_version,created_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                            params![version_id, material_id, input.original_snapshot_path, input.derived_snapshot_path, input.content_hash, input.size_bytes, input.mime_type, input.extractor_version, input.created_at_utc_ms],
                        )?;
                        transaction.execute(
                            "UPDATE codex_materials SET current_version_id=?1,snapshot_state='ready',display_name=?2,source_metadata_json=?3 WHERE id=?4",
                            params![version_id, input.display_name.trim(), input.source_metadata_json, material_id],
                        )?;
                        (material_id, version_id, false)
                    }
                };
                let item_id = Uuid::new_v4().to_string();
                transaction.execute(
                    "INSERT INTO codex_handoff_items(id,handoff_id,material_id,material_version_id,display_name,source_metadata_json,display_order,state) VALUES (?1,?2,?3,?4,?5,?6,?7,'ready')",
                    params![item_id, handoff_id, material_id, version_id, input.display_name.trim(), input.source_metadata_json, input.display_order],
                )?;
                reused.push(reused_existing);
            }
            require_changed(transaction.execute(
                "UPDATE codex_handoffs SET status='ready',error_summary=NULL WHERE id=?1 AND status='preparing'",
                [handoff_id],
            )?)?;
            Ok(reused)
        })
    }

    pub fn mark_handoff_failed(
        &self,
        handoff_id: &str,
        error_summary: &str,
    ) -> Result<(), AppError> {
        let error_summary = normalize_required(error_summary)?;
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_handoffs SET status='failed',error_summary=?1 WHERE id=?2 AND status='preparing'",
                params![error_summary, handoff_id],
            )?)
        })
    }

    pub fn find_handoff_by_request(
        &self,
        request_id: &str,
    ) -> Result<Option<CodexHandoffDetails>, AppError> {
        self.database.with_connection(|connection| {
            let id = connection
                .query_row(
                    "SELECT id FROM codex_handoffs WHERE request_id=?1",
                    [request_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            id.map(|id| load_handoff_details(connection, &id))
                .transpose()
        })
    }

    fn find_handoff_by_id(
        &self,
        handoff_id: &str,
    ) -> Result<Option<CodexHandoffDetails>, AppError> {
        self.database.with_connection(|connection| {
            let exists = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM codex_handoffs WHERE id=?1)",
                [handoff_id],
                |row| row.get::<_, bool>(0),
            )?;
            if exists {
                Ok(Some(load_handoff_details(connection, handoff_id)?))
            } else {
                Ok(None)
            }
        })
    }

    pub fn list_pending_handoffs(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<CodexHandoffDetails>, AppError> {
        self.database.with_connection(|connection| {
            let ids = {
                let mut statement = connection.prepare(
                    "SELECT id FROM codex_handoffs WHERE conversation_id=?1 AND status='ready' ORDER BY created_at_utc_ms,id",
                )?;
                statement
                    .query_map([conversation_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            ids.iter()
                .map(|id| load_handoff_details(connection, id))
                .collect()
        })
    }

    pub fn dismiss_handoff_item(
        &self,
        handoff_id: &str,
        material_id: &str,
    ) -> Result<(), AppError> {
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_handoff_items SET state='dismissed' WHERE handoff_id=?1 AND material_id=?2 AND state='ready' AND EXISTS(SELECT 1 FROM codex_handoffs h WHERE h.id=handoff_id AND h.status='ready')",
                params![handoff_id, material_id],
            )?)
        })
    }

    pub fn bind_turn_handoff(&self, turn_id: &str, handoff_id: &str) -> Result<(), AppError> {
        self.database.with_transaction(|transaction| {
            let inserted = transaction.execute(
                "INSERT OR IGNORE INTO codex_turn_handoffs(turn_id,handoff_id) SELECT t.id,h.id FROM codex_turns t JOIN codex_handoffs h ON h.conversation_id=t.conversation_id WHERE t.id=?1 AND h.id=?2",
                params![turn_id, handoff_id],
            )?;
            require_changed(inserted)
        })
    }

    pub fn consume_handoffs(
        &self,
        turn_id: &str,
        conversation_id: &str,
        handoff_ids: &[String],
        now: i64,
    ) -> Result<(), AppError> {
        if handoff_ids.is_empty() {
            return Err(AppError::InvalidConfig);
        }
        self.database.with_transaction(|transaction| {
            let turn_belongs: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM codex_turns WHERE id=?1 AND conversation_id=?2)",
                params![turn_id, conversation_id],
                |row| row.get(0),
            )?;
            if !turn_belongs {
                return Err(rusqlite::Error::InvalidQuery);
            }
            for handoff_id in handoff_ids {
                let ready: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM codex_handoffs WHERE id=?1 AND conversation_id=?2 AND status='ready')",
                    params![handoff_id, conversation_id],
                    |row| row.get(0),
                )?;
                if !ready {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                transaction.execute(
                    "INSERT INTO codex_turn_handoffs(turn_id,handoff_id) VALUES (?1,?2)",
                    params![turn_id, handoff_id],
                )?;
                transaction.execute(
                    "UPDATE codex_handoff_items SET state='consumed' WHERE handoff_id=?1 AND state='ready'",
                    [handoff_id],
                )?;
                require_changed(transaction.execute(
                    "UPDATE codex_handoffs SET status='consumed',consumed_at_utc_ms=?1 WHERE id=?2 AND status='ready'",
                    params![now, handoff_id],
                )?)?;
            }
            Ok(())
        })
    }

    pub fn list_turn_handoffs(&self, turn_id: &str) -> Result<Vec<String>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT handoff_id FROM codex_turn_handoffs WHERE turn_id=?1 ORDER BY handoff_id",
            )?;
            statement
                .query_map([turn_id], |row| row.get::<_, String>(0))?
                .collect()
        })
    }

    pub fn recover_interrupted_handoffs(&self, _now: i64) -> Result<usize, AppError> {
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "UPDATE codex_handoffs SET status='failed',error_summary='应用重启，资料交接未完成' WHERE status='preparing'",
                [],
            )
        })
    }

    pub fn set_material_state(&self, material_id: &str, state: &str) -> Result<(), AppError> {
        if !matches!(
            state,
            "ready" | "source_changed" | "unsupported" | "failed" | "removed"
        ) {
            return Err(AppError::InvalidConfig);
        }
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_materials SET snapshot_state=?1 WHERE id=?2",
                params![state, material_id],
            )?)
        })
    }

    pub fn record_artifact(&self, input: &CodexArtifactInput) -> Result<(), AppError> {
        if input.relative_path.trim().is_empty() || input.size_bytes < 0 {
            return Err(AppError::InvalidConfig);
        }
        let id = Uuid::new_v4().to_string();
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO codex_artifacts(id,project_id,relative_path,content_hash,size_bytes,mime_type,created_by_conversation_id,created_by_turn_id,detected_at_utc_ms,state) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'active') ON CONFLICT(project_id,relative_path) DO UPDATE SET content_hash=excluded.content_hash,size_bytes=excluded.size_bytes,mime_type=excluded.mime_type,created_by_conversation_id=excluded.created_by_conversation_id,created_by_turn_id=excluded.created_by_turn_id,detected_at_utc_ms=excluded.detected_at_utc_ms,state='active'",
                params![id, input.project_id, input.relative_path, input.content_hash, input.size_bytes, input.mime_type, input.created_by_conversation_id, input.created_by_turn_id, input.detected_at_utc_ms],
            )?;
            Ok(())
        })
    }

    pub fn list_artifacts(&self, project_id: &str) -> Result<Vec<CodexArtifact>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,project_id,relative_path,content_hash,size_bytes,mime_type,created_by_conversation_id,created_by_turn_id,detected_at_utc_ms,state FROM codex_artifacts WHERE project_id=?1 AND state='active' ORDER BY detected_at_utc_ms DESC,id",
            )?;
            statement.query_map([project_id], map_artifact)?.collect()
        })
    }

    pub fn find_artifact(&self, artifact_id: &str) -> Result<Option<CodexArtifact>, AppError> {
        self.database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id,project_id,relative_path,content_hash,size_bytes,mime_type,created_by_conversation_id,created_by_turn_id,detected_at_utc_ms,state FROM codex_artifacts WHERE id=?1",
                    [artifact_id],
                    map_artifact,
                )
                .optional()
        })
    }

    pub fn record_artifact_upload(
        &self,
        input: &CodexArtifactUploadInput,
    ) -> Result<CodexArtifactUpload, AppError> {
        if !matches!(
            input.status.as_str(),
            "uploading" | "uploaded" | "uploaded_parse_failed" | "uncertain" | "failed"
        ) || input.dataset_id.trim().is_empty()
            || input.content_hash.trim().is_empty()
            || input
                .document_ids_json
                .as_deref()
                .is_some_and(|value| serde_json::from_str::<serde_json::Value>(value).is_err())
        {
            return Err(AppError::InvalidConfig);
        }
        let id = Uuid::new_v4().to_string();
        let parent_path = input
            .parent_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO codex_artifact_uploads(id,artifact_id,dataset_id,parent_path,content_hash,document_ids_json,status,start_parsing,created_at_utc_ms,completed_at_utc_ms,error_summary) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![id, input.artifact_id, input.dataset_id.trim(), parent_path, input.content_hash, input.document_ids_json, input.status, input.start_parsing, input.created_at_utc_ms, input.completed_at_utc_ms, input.error_summary],
            )?;
            transaction.query_row(
                "SELECT id,artifact_id,dataset_id,parent_path,content_hash,document_ids_json,status,start_parsing,created_at_utc_ms,completed_at_utc_ms,error_summary FROM codex_artifact_uploads WHERE id=?1",
                [&id],
                map_artifact_upload,
            )
        })
    }

    pub fn list_artifact_uploads(
        &self,
        artifact_id: &str,
    ) -> Result<Vec<CodexArtifactUpload>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,artifact_id,dataset_id,parent_path,content_hash,document_ids_json,status,start_parsing,created_at_utc_ms,completed_at_utc_ms,error_summary FROM codex_artifact_uploads WHERE artifact_id=?1 ORDER BY created_at_utc_ms DESC,id",
            )?;
            statement
                .query_map([artifact_id], map_artifact_upload)?
                .collect()
        })
    }

    pub fn finish_artifact_upload(
        &self,
        upload_id: &str,
        status: &str,
        document_ids_json: Option<&str>,
        completed_at_utc_ms: i64,
        error_summary: Option<&str>,
    ) -> Result<CodexArtifactUpload, AppError> {
        if !matches!(
            status,
            "uploaded" | "uploaded_parse_failed" | "uncertain" | "failed"
        ) || document_ids_json
            .is_some_and(|value| serde_json::from_str::<serde_json::Value>(value).is_err())
        {
            return Err(AppError::InvalidConfig);
        }
        self.database.with_transaction(|transaction| {
            require_changed(transaction.execute(
                "UPDATE codex_artifact_uploads SET status=?2,document_ids_json=?3,completed_at_utc_ms=?4,error_summary=?5 WHERE id=?1 AND status='uploading'",
                params![upload_id, status, document_ids_json, completed_at_utc_ms, error_summary],
            )?)?;
            transaction.query_row(
                "SELECT id,artifact_id,dataset_id,parent_path,content_hash,document_ids_json,status,start_parsing,created_at_utc_ms,completed_at_utc_ms,error_summary FROM codex_artifact_uploads WHERE id=?1",
                [upload_id],
                map_artifact_upload,
            )
        })
    }

    pub fn recover_interrupted_artifact_uploads(&self, now: i64) -> Result<usize, AppError> {
        self.database.with_connection(|connection| {
            connection.execute(
                "UPDATE codex_artifact_uploads SET status='uncertain',completed_at_utc_ms=?1,error_summary='应用在上传完成前退出；请求可能已经到达 RAGFlow，请检查知识库后再决定是否重试。' WHERE status='uploading'",
                [now],
            )
        })
    }

    pub fn record_approval(&self, input: &CodexApprovalInput) -> Result<(), AppError> {
        let id = Uuid::new_v4().to_string();
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO codex_approval_records(id,project_id,conversation_id,turn_id,item_id,action_type,target_summary,decision,created_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![id, input.project_id, input.conversation_id, input.turn_id, input.item_id, input.action_type, input.target_summary, input.decision, input.created_at_utc_ms],
            )?;
            Ok(())
        })
    }

    pub fn list_approvals(&self, turn_id: &str) -> Result<Vec<CodexApprovalRecord>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,project_id,conversation_id,turn_id,item_id,action_type,target_summary,decision,created_at_utc_ms FROM codex_approval_records WHERE turn_id=?1 ORDER BY created_at_utc_ms,id",
            )?;
            statement.query_map([turn_id], map_approval)?.collect()
        })
    }

    pub fn get_preferences(&self) -> Result<CodexPreferences, AppError> {
        self.database.with_connection(|connection| {
            connection.query_row(
                "SELECT model,reasoning_effort FROM codex_preferences WHERE id=1",
                [],
                |row| {
                    Ok(CodexPreferences {
                        model: row.get(0)?,
                        reasoning_effort: row.get(1)?,
                    })
                },
            )
        })
    }

    pub fn save_preferences(&self, model: &str, reasoning_effort: &str) -> Result<(), AppError> {
        let model = model.trim();
        if model.len() > 120 || !matches!(reasoning_effort, "low" | "medium" | "high" | "xhigh") {
            return Err(AppError::InvalidConfig);
        }
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "UPDATE codex_preferences SET model=?1,reasoning_effort=?2 WHERE id=1",
                params![model, reasoning_effort],
            )?;
            Ok(())
        })
    }
}

fn normalize_required(value: &str) -> Result<&str, AppError> {
    let value = value.trim();
    if value.is_empty() {
        Err(AppError::InvalidConfig)
    } else {
        Ok(value)
    }
}

fn require_changed(changed: usize) -> rusqlite::Result<()> {
    if changed == 0 {
        Err(rusqlite::Error::QueryReturnedNoRows)
    } else {
        Ok(())
    }
}

fn map_project(row: &Row<'_>) -> rusqlite::Result<CodexProject> {
    Ok(CodexProject {
        id: row.get(0)?,
        name: row.get(1)?,
        goal: row.get(2)?,
        root_path: row.get(3)?,
        status: row.get(4)?,
        created_at_utc_ms: row.get(5)?,
        updated_at_utc_ms: row.get(6)?,
        last_opened_at_utc_ms: row.get(7)?,
    })
}

fn map_conversation(row: &Row<'_>) -> rusqlite::Result<CodexConversation> {
    Ok(CodexConversation {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        codex_thread_id: row.get(3)?,
        codex_session_id: row.get(4)?,
        status: row.get(5)?,
        created_at_utc_ms: row.get(6)?,
        updated_at_utc_ms: row.get(7)?,
        archived_at_utc_ms: row.get(8)?,
    })
}

fn map_turn(row: &Row<'_>) -> rusqlite::Result<CodexTurnProjection> {
    Ok(CodexTurnProjection {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        codex_turn_id: row.get(2)?,
        user_text: row.get(3)?,
        status: row.get(4)?,
        started_at_utc_ms: row.get(5)?,
        completed_at_utc_ms: row.get(6)?,
        error_summary: row.get(7)?,
    })
}

fn map_message(row: &Row<'_>) -> rusqlite::Result<CodexMessage> {
    Ok(CodexMessage {
        id: row.get(0)?,
        turn_id: row.get(1)?,
        role: row.get(2)?,
        markdown: row.get(3)?,
        status: row.get(4)?,
        created_at_utc_ms: row.get(5)?,
    })
}

fn map_process_item(row: &Row<'_>) -> rusqlite::Result<CodexProcessItem> {
    Ok(CodexProcessItem {
        id: row.get(0)?,
        turn_id: row.get(1)?,
        codex_item_id: row.get(2)?,
        kind: row.get(3)?,
        title: row.get(4)?,
        safe_summary: row.get(5)?,
        status: row.get(6)?,
    })
}

fn map_material(row: &Row<'_>) -> rusqlite::Result<CodexMaterial> {
    Ok(CodexMaterial {
        id: row.get(0)?,
        project_id: row.get(1)?,
        kind: row.get(2)?,
        display_name: row.get(3)?,
        origin_reference: row.get(4)?,
        source_metadata_json: row.get(5)?,
        current_version_id: row.get(6)?,
        snapshot_state: row.get(7)?,
        imported_at_utc_ms: row.get(8)?,
    })
}

fn map_handoff(row: &Row<'_>) -> rusqlite::Result<CodexHandoff> {
    Ok(CodexHandoff {
        id: row.get(0)?,
        request_id: row.get(1)?,
        source_kind: row.get(2)?,
        project_id: row.get(3)?,
        conversation_id: row.get(4)?,
        status: row.get(5)?,
        created_at_utc_ms: row.get(6)?,
        consumed_at_utc_ms: row.get(7)?,
        error_summary: row.get(8)?,
    })
}

fn map_handoff_item(row: &Row<'_>) -> rusqlite::Result<CodexHandoffItem> {
    Ok(CodexHandoffItem {
        id: row.get(0)?,
        handoff_id: row.get(1)?,
        material_id: row.get(2)?,
        material_version_id: row.get(3)?,
        display_name: row.get(4)?,
        source_metadata_json: row.get(5)?,
        display_order: row.get(6)?,
        state: row.get(7)?,
    })
}

fn load_handoff_details(
    connection: &rusqlite::Connection,
    handoff_id: &str,
) -> rusqlite::Result<CodexHandoffDetails> {
    let handoff = connection.query_row(
        "SELECT id,request_id,source_kind,project_id,conversation_id,status,created_at_utc_ms,consumed_at_utc_ms,error_summary FROM codex_handoffs WHERE id=?1",
        [handoff_id],
        map_handoff,
    )?;
    let items = {
        let mut statement = connection.prepare(
            "SELECT id,handoff_id,material_id,material_version_id,display_name,source_metadata_json,display_order,state FROM codex_handoff_items WHERE handoff_id=?1 ORDER BY display_order,id",
        )?;
        statement
            .query_map([handoff_id], map_handoff_item)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(CodexHandoffDetails { handoff, items })
}

fn map_material_version(row: &Row<'_>) -> rusqlite::Result<CodexMaterialVersion> {
    Ok(CodexMaterialVersion {
        id: row.get(0)?,
        material_id: row.get(1)?,
        original_snapshot_path: row.get(2)?,
        derived_snapshot_path: row.get(3)?,
        content_hash: row.get(4)?,
        size_bytes: row.get(5)?,
        mime_type: row.get(6)?,
        extractor_version: row.get(7)?,
        created_at_utc_ms: row.get(8)?,
    })
}

fn map_artifact(row: &Row<'_>) -> rusqlite::Result<CodexArtifact> {
    Ok(CodexArtifact {
        id: row.get(0)?,
        project_id: row.get(1)?,
        relative_path: row.get(2)?,
        content_hash: row.get(3)?,
        size_bytes: row.get(4)?,
        mime_type: row.get(5)?,
        created_by_conversation_id: row.get(6)?,
        created_by_turn_id: row.get(7)?,
        detected_at_utc_ms: row.get(8)?,
        state: row.get(9)?,
    })
}

fn map_artifact_upload(row: &Row<'_>) -> rusqlite::Result<CodexArtifactUpload> {
    Ok(CodexArtifactUpload {
        id: row.get(0)?,
        artifact_id: row.get(1)?,
        dataset_id: row.get(2)?,
        parent_path: row.get(3)?,
        content_hash: row.get(4)?,
        document_ids_json: row.get(5)?,
        status: row.get(6)?,
        start_parsing: row.get(7)?,
        created_at_utc_ms: row.get(8)?,
        completed_at_utc_ms: row.get(9)?,
        error_summary: row.get(10)?,
    })
}

fn map_approval(row: &Row<'_>) -> rusqlite::Result<CodexApprovalRecord> {
    Ok(CodexApprovalRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        conversation_id: row.get(2)?,
        turn_id: row.get(3)?,
        item_id: row.get(4)?,
        action_type: row.get(5)?,
        target_summary: row.get(6)?,
        decision: row.get(7)?,
        created_at_utc_ms: row.get(8)?,
    })
}
