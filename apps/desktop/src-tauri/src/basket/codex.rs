use super::{
    Basket,
    store::{OpenSnapshot, STORAGE},
};
use crate::{
    codex::{
        CodexProjectFiles, HandoffFileSource, details_result, metadata_modified_ms, mime_type_for,
    },
    contracts::CodexHandoffResult,
    database::repositories::codex_repository::CommitHandoffMaterialInput,
};
use std::{collections::HashSet, fs, io, path::Path};
use uuid::Uuid;

pub(super) fn attach(
    basket: &Basket,
    files: &CodexProjectFiles,
    ids: &[String],
    project: &str,
    conversation: &str,
    request: &str,
) -> Result<CodexHandoffResult, String> {
    if project.trim().is_empty()
        || conversation.trim().is_empty()
        || Uuid::parse_str(request).is_err()
        || ids.is_empty()
    {
        return Err("请选择资料、项目和会话，再使用资料筐。".into());
    }
    let mut seen = HashSet::new();
    let mut ids = ids
        .iter()
        .filter(|i| seen.insert(i.as_str()))
        .collect::<Vec<_>>();
    let repo = basket.db.codex();
    let identity = serde_json::to_string(&(project, conversation, &ids)).map_err(|_| STORAGE)?;
    let key = format!("basket:{request}:{}", super::store::digest_text(&identity));
    if let Some(old) = repo.find_handoff_by_request(&key).map_err(|_| STORAGE)? {
        if old.handoff.project_id != project
            || old.handoff.conversation_id != conversation
            || old.handoff.source_kind != "basket"
        {
            return Err("此附件请求已用于其他会话，请重新选择。".into());
        }
        if matches!(old.handoff.status.as_str(), "ready" | "consumed") {
            return Ok(details_result(&old));
        }
        return Err("该附件请求已处理或正在处理，请刷新附件后重新选择。".into());
    }
    if repo.project_has_active_turn(project).map_err(|_| STORAGE)? {
        return Err("该 Codex 项目正在执行任务，请稍后再添加附件。".into());
    }
    if !repo
        .list_conversations(project, false)
        .map_err(|_| STORAGE)?
        .iter()
        .any(|c| c.id == conversation)
    {
        return Err("所选项目与会话不匹配。".into());
    }
    let pending = repo
        .list_pending_handoffs(conversation)
        .map_err(|_| STORAGE)?;
    let mut already_pending = HashSet::new();
    let mut reused = None;
    for group in &pending {
        for item in group.items.iter().filter(|item| item.state == "ready") {
            let metadata: serde_json::Value =
                serde_json::from_str(&item.source_metadata_json).unwrap_or_default();
            if let Some(id) = metadata.get("basketId").and_then(serde_json::Value::as_str)
                && seen.contains(id)
            {
                already_pending.insert(id.to_owned());
                reused = Some(group);
            }
        }
    }
    ids.retain(|id| !already_pending.contains(id.as_str()));
    if ids.is_empty()
        && let Some(group) = reused
    {
        return Ok(details_result(group));
    }
    let temp = tempfile::tempdir().map_err(|_| STORAGE)?;
    let mut sources = Vec::with_capacity(ids.len());
    let mut entries = Vec::with_capacity(ids.len());
    for (idx, id) in ids.iter().enumerate() {
        let OpenSnapshot { item, mut file } = basket.open(id)?;
        let sub = temp.path().join(idx.to_string());
        fs::create_dir(&sub).map_err(|_| STORAGE)?;
        let path = sub.join(crate::factory::suggested_name(&item.display_name));
        let mut dst = fs::File::create(&path).map_err(|_| STORAGE)?;
        io::copy(&mut file, &mut dst).map_err(|_| STORAGE)?;
        let meta = dst.metadata().map_err(|_| STORAGE)?;
        drop(dst);
        sources.push(HandoffFileSource {
            source_path: path,
            expected_size_bytes: meta.len(),
            expected_modified_at_utc_ms: metadata_modified_ms(&meta),
        });
        entries.push(item);
    }
    let staging = Uuid::new_v4().to_string();
    let layout = files.create_layout(project).map_err(|_| STORAGE)?;
    // The basket already holds an immutable original. Keep that original even if text extraction is unavailable.
    let staged = files
        .stage_handoff_files(project, &staging, &sources, true, true)
        .map_err(|e| e.to_string())?;
    let handoff = repo
        .create_handoff(
            &key,
            "basket",
            project,
            conversation,
            chrono::Utc::now().timestamp_millis(),
        )
        .map_err(|_| {
            let _ = files.discard_staging(project, &staging);
            "无法准备当前会话的附件，请刷新后重试。"
        })?;
    let committed = files
        .commit_staged_handoff(project, &staging, &staged)
        .map_err(|_| {
            let _ = files.discard_staging(project, &staging);
            let _ = repo.mark_handoff_failed(&handoff.id, "无法保存资料附件");
            STORAGE
        })?;
    let persist = (|| {
        let relative = |path: &Path| {
            path.strip_prefix(&layout.root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .map_err(|_| STORAGE)
        };
        let mut inputs = Vec::with_capacity(entries.len());
        for (i, (item, snapshot)) in entries.iter().zip(&committed).enumerate() {
            if snapshot.content_hash != item.sha256 {
                return Err(STORAGE);
            }
            let kind = match item.kind.as_str() {
                "ragflowChunk" => "ragflow_chunk",
                "ragflowDocument" => "ragflow_document",
                _ => "local",
            };
            let metadata = serde_json::json!({"basketId":item.id, "basketKind":item.kind, "source":item.source_label});
            inputs.push(CommitHandoffMaterialInput {
                kind: kind.into(),
                origin_reference: format!("basket:{}", item.id),
                display_name: item.display_name.clone(),
                source_metadata_json: metadata.to_string(),
                original_snapshot_path: relative(&snapshot.original_snapshot_path)?,
                derived_snapshot_path: snapshot
                    .derived_snapshot_path
                    .as_deref()
                    .map(relative)
                    .transpose()?,
                content_hash: snapshot.content_hash.clone(),
                size_bytes: item.size_bytes,
                mime_type: mime_type_for(Path::new(&item.display_name)).into(),
                extractor_version: "qizhi-1".into(),
                created_at_utc_ms: chrono::Utc::now().timestamp_millis(),
                display_order: i as i64,
            });
        }
        repo.commit_handoff_materials(&handoff.id, project, &inputs)
            .map_err(|_| STORAGE)
    })();
    let cleanup = |f: &crate::codex::CommittedHandoffFile| {
        let _ = fs::remove_file(&f.original_snapshot_path);
        if let Some(p) = &f.derived_snapshot_path {
            let _ = fs::remove_file(p);
        }
    };
    match persist {
        Ok(reused) => {
            for (f, reused) in committed.iter().zip(reused) {
                if reused {
                    cleanup(f);
                }
            }
        }
        Err(e) => {
            for f in &committed {
                cleanup(f);
            }
            let _ = repo.mark_handoff_failed(&handoff.id, "无法记录资料附件");
            return Err(e.into());
        }
    }
    Ok(CodexHandoffResult {
        handoff_id: handoff.id,
        project_id: project.into(),
        conversation_id: conversation.into(),
        item_count: entries.len(),
        status: "ready".into(),
    })
}
