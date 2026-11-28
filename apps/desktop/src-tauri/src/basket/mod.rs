mod codex;
mod store;
pub(crate) use store::selected_file;
pub use store::{Basket, BasketItem, BasketResult};

use crate::{
    app_state::AppState, commands::knowledge::upload_policy,
    config::secret_store::SystemCredentialStore, contracts::CodexHandoffResult,
    ragflow::client::RagflowClient,
};
use serde::Deserialize;
use std::collections::HashSet;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

const EXPIRED: &str = "知识库选择已失效，请重新查询并选择资料。";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkId {
    dataset_id: String,
    document_id: String,
    chunk_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocId {
    dataset_id: String,
    document_id: String,
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BasketSource {
    Today {
        query_id: String,
        file_ids: Vec<i64>,
        directory_ids: Vec<String>,
    },
    Recent {
        query_id: String,
        file_ids: Vec<i64>,
        directory_ids: Vec<String>,
    },
    RagflowChunks {
        selection_token: String,
        chunks: Vec<ChunkId>,
    },
    RagflowDocuments {
        selection_token: String,
        documents: Vec<DocId>,
    },
}

fn add_workspace(
    basket: &Basket,
    state: &AppState,
    kind: &str,
    label: &str,
    query_id: String,
    file_ids: Vec<i64>,
    directory_ids: Vec<String>,
) -> Result<Vec<BasketResult>, String> {
    let ids = state
        .workspace_queries
        .resolve(&query_id, &file_ids, &directory_ids)?;
    if ids.is_empty() {
        return Err("所选文件或目录已失效，请刷新后重新选择。".into());
    }
    let (policy, filter) = upload_policy(state)?;
    Ok(ids
        .into_iter()
        .map(|id| {
            let mut name = format!("文件 {id}");
            let result = (|| {
                let record = state
                    .database
                    .files()
                    .get_by_id(id)
                    .map_err(|_| store::STORAGE)?
                    .ok_or(store::SOURCE)?;
                name = std::path::Path::new(&record.canonical_path)
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or("本地文件")
                    .to_owned();
                let path = std::path::PathBuf::from(&record.canonical_path);
                if !policy.is_allowed_record(&record) || !filter.allows(&path) {
                    return Err("文件已不在允许的范围内，请重新选择。".into());
                }
                #[cfg(target_os = "macos")]
                return basket.local_snapshot(
                    kind,
                    label,
                    &path,
                    state
                        .scan_rules
                        .open_indexed_record(&record)
                        .map_err(|_| store::SOURCE)?,
                );
                #[cfg(not(target_os = "macos"))]
                basket.local(kind, label, &path)
            })();
            result.unwrap_or_else(|e| BasketResult::failed(id.to_string(), name, e))
        })
        .collect())
}
fn add_source(
    basket: &Basket,
    state: &AppState,
    source: BasketSource,
) -> Result<Vec<BasketResult>, String> {
    match source {
        BasketSource::Today {
            query_id,
            file_ids,
            directory_ids,
        } => add_workspace(
            basket,
            state,
            "today",
            "今日文件",
            query_id,
            file_ids,
            directory_ids,
        ),
        BasketSource::Recent {
            query_id,
            file_ids,
            directory_ids,
        } => add_workspace(
            basket,
            state,
            "recent",
            "近期文件",
            query_id,
            file_ids,
            directory_ids,
        ),
        BasketSource::RagflowChunks {
            selection_token,
            chunks,
        } => {
            let mut seen = HashSet::new();
            Ok(chunks
                .into_iter()
                .filter(|id| {
                    seen.insert((
                        id.dataset_id.clone(),
                        id.document_id.clone(),
                        id.chunk_id.clone(),
                    ))
                })
                .map(|id| {
                    let Some((site, _question, c)) = state.knowledge_selections.chunk(
                        &selection_token,
                        &id.dataset_id,
                        &id.document_id,
                        &id.chunk_id,
                    ) else {
                        return BasketResult::failed(
                            id.chunk_id,
                            "知识片段".into(),
                            EXPIRED.into(),
                        );
                    };
                    let name = format!("{}-{}.md", c.document_name, c.chunk_id);
                    let key = serde_json::json!([
                        "ragflowChunk",
                        site,
                        c.dataset_id,
                        c.document_id,
                        c.chunk_id
                    ])
                    .to_string();
                    // Leave the complete evidence body intact, including whitespace and line endings.
                    let markdown = format!(
                        "# {}\n\n- 知识库：{}\n- 文档：{}\n- 片段：{}\n\n## 片段原文\n\n{}",
                        c.document_name, c.dataset_id, c.document_id, c.chunk_id, c.content
                    );
                    basket
                        .add(
                            key,
                            "ragflowChunk",
                            &format!("知识片段 · {}", c.document_name),
                            &name,
                            markdown.as_bytes(),
                        )
                        .unwrap_or_else(|e| BasketResult::failed(id.chunk_id, name, e))
                })
                .collect())
        }
        BasketSource::RagflowDocuments {
            selection_token,
            documents,
        } => {
            let client =
                RagflowClient::from_saved_config(state.database.configs(), SystemCredentialStore);
            let mut seen = HashSet::new();
            Ok(documents
                .into_iter()
                .filter(|id| seen.insert((id.dataset_id.clone(), id.document_id.clone())))
                .map(|id| {
                    let Some((site, name)) = state.knowledge_selections.document(
                        &selection_token,
                        &id.dataset_id,
                        &id.document_id,
                    ) else {
                        return BasketResult::failed(
                            id.document_id,
                            "知识库原件".into(),
                            EXPIRED.into(),
                        );
                    };
                    let result = (|| {
                        let client = client
                            .as_ref()
                            .map_err(|_| "无法读取知识库连接设置，请在设置中检查后重试。")?;
                        if client.configured_endpoint() != site {
                            return Err("知识库连接已更换，请重新查询并选择原件。".into());
                        }
                        let bytes = client
                            .download_document(&id.dataset_id, &id.document_id)
                            .map_err(|_| "知识库原件下载失败，请检查服务或文档权限后重新加入。")?;
                        let key = serde_json::json!([
                            "ragflowDocument",
                            site,
                            id.dataset_id,
                            id.document_id
                        ])
                        .to_string();
                        basket.add(
                            key,
                            "ragflowDocument",
                            &format!("知识库原件 · {name}"),
                            &name,
                            bytes.as_slice(),
                        )
                    })();
                    result.unwrap_or_else(|e| BasketResult::failed(id.document_id, name, e))
                })
                .collect())
        }
    }
}

#[tauri::command]
pub fn basket_list(basket: State<'_, Basket>) -> Result<Vec<BasketItem>, String> {
    basket.list()
}
#[tauri::command]
pub async fn basket_add(
    source: BasketSource,
    basket: State<'_, Basket>,
    state: State<'_, AppState>,
) -> Result<Vec<BasketResult>, String> {
    let basket = basket.inner().clone();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || add_source(&basket, &state, source))
        .await
        .map_err(|_| store::STORAGE.to_owned())?
}
#[tauri::command]
pub async fn basket_pick_local(
    app: tauri::AppHandle,
    basket: State<'_, Basket>,
) -> Result<Vec<BasketResult>, String> {
    let basket = basket.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(i, file)| {
                let Ok(path) = file.into_path() else {
                    return BasketResult::failed(
                        i.to_string(),
                        "本地文件".into(),
                        store::SOURCE.into(),
                    );
                };
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("本地文件")
                    .to_owned();
                basket
                    .local("local", "本地文件", &path)
                    .unwrap_or_else(|e| BasketResult::failed(i.to_string(), name, e))
            })
            .collect()
    })
    .await
    .map_err(|_| store::STORAGE.into())
}
#[tauri::command]
pub fn basket_remove(item_ids: Vec<String>, basket: State<'_, Basket>) -> Result<(), String> {
    basket.remove(&item_ids)
}
#[tauri::command]
pub fn basket_clear(basket: State<'_, Basket>) -> Result<(), String> {
    basket.clear()
}
#[tauri::command]
pub async fn basket_attach_codex(
    item_ids: Vec<String>,
    project_id: String,
    conversation_id: String,
    request_id: String,
    basket: State<'_, Basket>,
    state: State<'_, AppState>,
) -> Result<CodexHandoffResult, String> {
    let basket = basket.inner().clone();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = state
            .codex_runtime
            .reserve_project_mutation(&project_id)
            .map_err(|_| "该 Codex 项目正在执行任务，请结束后重试。")?;
        codex::attach(
            &basket,
            &state.codex_handoffs.files,
            &item_ids,
            &project_id,
            &conversation_id,
            &request_id,
        )
    })
    .await
    .map_err(|_| store::STORAGE.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        codex::CodexProjectFiles, contracts::CodexRagflowChunkInput, database::Database,
        knowledge_selection::KnowledgeSelectionStore,
    };
    use std::io::Read;

    #[test]
    fn snapshots_survive_restart_changes_and_removal_and_attach_only_to_selected_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let dbpath = base.join("test.sqlite");
        let source = base.join("测试.md");
        let root = base.join("basket");
        std::fs::write(&source, b"original text").unwrap();
        let db = Database::open(&dbpath).unwrap();
        let basket = Basket::new(db, root.clone());
        let first = basket
            .local("today", "今日文件", &source)
            .unwrap()
            .item
            .unwrap();
        assert_eq!(
            basket.local("recent", "近期文件", &source).unwrap().status,
            "existing"
        );
        std::fs::write(&source, b"updated text").unwrap();
        assert_eq!(
            basket.local("recent", "近期文件", &source).unwrap().status,
            "added"
        );
        std::fs::remove_file(&source).unwrap();
        drop(basket);
        let db = Database::open(&dbpath).unwrap();
        let basket = Basket::new(db.clone(), root.clone());
        let mut bytes = String::new();
        basket
            .open(&first.id)
            .unwrap()
            .file
            .read_to_string(&mut bytes)
            .unwrap();
        assert_eq!(bytes, "original text");
        assert!(basket.open("../bad").is_err());
        let files = CodexProjectFiles::new(base.join("projects"));
        let p = db.codex().create_project("P", None, "managed", 1).unwrap();
        let c = db.codex().create_conversation(&p.id, "C", 1).unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        let ids = vec![first.id.clone()];
        let result = codex::attach(&basket, &files, &ids, &p.id, &c.id, &request).unwrap();
        assert_eq!(result.item_count, 1);
        assert_eq!(result.status, "ready");
        assert_eq!(
            codex::attach(&basket, &files, &ids, &p.id, &c.id, &request)
                .unwrap()
                .handoff_id,
            result.handoff_id
        );
        let repeat = codex::attach(
            &basket,
            &files,
            &ids,
            &p.id,
            &c.id,
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        assert_eq!(repeat.handoff_id, result.handoff_id);
        let queue = db.codex().list_pending_handoffs(&c.id).unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].items.len(), 1);
        assert_eq!(db.codex().list_materials(&p.id).unwrap().len(), 1);
        assert_eq!(
            db.with_connection(|conn| conn.query_row(
                "SELECT count(*) FROM codex_turns",
                [],
                |row| row.get::<_, i64>(0)
            ))
            .unwrap(),
            0
        );
        basket.remove(&ids).unwrap();
        assert!(basket.open(&first.id).is_err());
        let version = db
            .codex()
            .get_material_version(&queue[0].items[0].material_version_id)
            .unwrap()
            .unwrap();
        let attached = files
            .create_layout(&p.id)
            .unwrap()
            .root
            .join(version.original_snapshot_path);
        assert_eq!(std::fs::read(attached).unwrap(), b"original text");
        basket.clear().unwrap();
        assert!(basket.list().unwrap().is_empty());
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
    }
    #[test]
    fn invalid_selection_and_corruption_do_not_return_a_different_document() {
        let selection = KnowledgeSelectionStore::default();
        let c = CodexRagflowChunkInput {
            chunk_id: "c".into(),
            dataset_id: "ds".into(),
            document_id: "doc".into(),
            document_name: "研究.md".into(),
            content: "  原文\n末尾  ".into(),
            similarity: 0.8,
            retrieved_at_utc_ms: 1,
        };
        let token = selection.register_query("http://kb/".into(), "Q".into(), vec![c], []);
        assert!(selection.document(&token, "ds", "other").is_none());
        assert!(selection.chunk("expired", "ds", "doc", "c").is_none());
        assert_eq!(
            selection.chunk(&token, "ds", "doc", "c").unwrap().2.content,
            "  原文\n末尾  "
        );
        let dir = tempfile::tempdir().unwrap();
        let basket = Basket::new(
            Database::open(&dir.path().join("db")).unwrap(),
            dir.path().join("basket"),
        );
        let item = basket
            .add(
                "ds:doc".into(),
                "ragflowDocument",
                "知识库原件",
                "报告.pdf",
                &b"real pdf bytes"[..],
            )
            .unwrap()
            .item
            .unwrap();
        std::fs::write(dir.path().join("basket").join(&item.id), b"corrupt").unwrap();
        assert!(basket.open(&item.id).is_err());
        assert_eq!(
            basket
                .add(
                    "ds:doc".into(),
                    "ragflowDocument",
                    "知识库原件",
                    "报告.pdf",
                    &b"real pdf bytes"[..]
                )
                .unwrap()
                .status,
            "existing"
        );
        assert!(basket.open(&item.id).is_ok());
    }
}
