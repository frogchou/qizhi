use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{State, ipc::Channel};
use uuid::Uuid;

use crate::{
    app_state::AppState,
    config::secret_store::WindowsCredentialStore,
    contracts::{
        CodexArtifact, CodexConversation, CodexConversationHistory, CodexMaterial,
        CodexMaterialSourceStatus, CodexMaterialVersionInput, CodexPreferences, CodexProject,
        CodexTurnEvent, CodexTurnResult, StartCodexTurnInput,
    },
    database::AppError,
    ragflow::client::RagflowClient,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    pub goal: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameInput {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConversationInput {
    pub project_id: String,
    pub title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMaterialsInput {
    pub project_id: String,
    pub paths: Vec<String>,
    #[serde(default)]
    pub confirm_large_files: bool,
}

#[tauri::command]
pub fn get_codex_status(
    state: State<'_, AppState>,
) -> Result<crate::codex::CodexRuntimeStatus, String> {
    state.codex_runtime.status().map_err(user_runtime_error)
}

#[tauri::command]
pub fn refresh_codex_status(
    state: State<'_, AppState>,
) -> Result<crate::codex::CodexRuntimeStatus, String> {
    state
        .codex_runtime
        .refresh_status()
        .map_err(user_runtime_error)
}

#[tauri::command]
pub fn list_codex_models(
    state: State<'_, AppState>,
) -> Result<Vec<crate::codex::CodexModelOption>, String> {
    state
        .codex_runtime
        .list_models()
        .map_err(user_runtime_error)
}

#[tauri::command]
pub fn get_codex_preferences(state: State<'_, AppState>) -> Result<CodexPreferences, String> {
    state
        .database
        .codex()
        .get_preferences()
        .map_err(|_| "无法读取 Codex 偏好设置。".to_owned())
}

#[tauri::command]
pub fn save_codex_preferences(
    model: String,
    reasoning_effort: String,
    state: State<'_, AppState>,
) -> Result<CodexPreferences, String> {
    state
        .database
        .codex()
        .save_preferences(&model, &reasoning_effort)
        .map_err(|_| "模型或推理强度设置无效。".to_owned())?;
    state
        .database
        .codex()
        .get_preferences()
        .map_err(|_| "无法保存 Codex 偏好设置。".to_owned())
}

#[tauri::command]
pub fn list_codex_projects(
    include_archived: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<CodexProject>, String> {
    let mut projects = state
        .database
        .codex()
        .list_projects(include_archived.unwrap_or(false))
        .map_err(|_| "无法读取 Codex 项目。".to_owned())?;
    for project in &mut projects {
        if state.codex_runtime.project_has_active_turn(&project.id) {
            project.status = "running".to_owned();
        }
    }
    Ok(projects)
}

#[tauri::command]
pub fn create_codex_project(
    input: CreateProjectInput,
    state: State<'_, AppState>,
) -> Result<CodexProject, String> {
    let project = state
        .database
        .codex()
        .create_project(&input.name, input.goal.as_deref(), "managed", now_ms())
        .map_err(|error| match error {
            AppError::InvalidConfig => "项目名称不能为空。".to_owned(),
            _ => "无法创建 Codex 项目，请重试。".to_owned(),
        })?;
    state
        .codex_runtime
        .project_files()
        .create_layout(&project.id)
        .map_err(|_| "无法创建项目工作目录。".to_owned())?;
    Ok(project)
}

#[tauri::command]
pub fn rename_codex_project(input: RenameInput, state: State<'_, AppState>) -> Result<(), String> {
    state
        .database
        .codex()
        .rename_project(&input.id, &input.name, now_ms())
        .map_err(|_| "无法重命名项目。".to_owned())
}

#[tauri::command]
pub fn archive_codex_project(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .database
        .codex()
        .set_project_status(&project_id, "archived", now_ms())
        .map_err(|_| "无法归档项目。".to_owned())
}

#[tauri::command]
pub fn list_codex_conversations(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CodexConversation>, String> {
    state
        .database
        .codex()
        .list_conversations(&project_id, false)
        .map_err(|_| "无法读取项目会话。".to_owned())
}

#[tauri::command]
pub fn create_codex_conversation(
    input: CreateConversationInput,
    state: State<'_, AppState>,
) -> Result<CodexConversation, String> {
    state
        .database
        .codex()
        .create_conversation(&input.project_id, &input.title, now_ms())
        .map_err(|_| "无法创建会话，请检查项目和标题。".to_owned())
}

#[tauri::command]
pub fn rename_codex_conversation(
    input: RenameInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .database
        .codex()
        .rename_conversation(&input.id, &input.name, now_ms())
        .map_err(|_| "无法重命名会话。".to_owned())
}

#[tauri::command]
pub fn archive_codex_conversation(
    conversation_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .database
        .codex()
        .set_conversation_status(&conversation_id, "archived", now_ms())
        .map_err(|_| "无法归档会话。".to_owned())
}

#[tauri::command]
pub fn read_codex_conversation(
    conversation_id: String,
    state: State<'_, AppState>,
) -> Result<CodexConversationHistory, String> {
    state
        .database
        .codex()
        .read_conversation(&conversation_id)
        .map_err(|_| "无法读取会话记录。".to_owned())
}

#[tauri::command]
pub fn list_codex_materials(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CodexMaterial>, String> {
    state
        .database
        .codex()
        .list_materials(&project_id)
        .map_err(|_| "无法读取项目资料。".to_owned())
}

#[tauri::command]
pub fn inspect_codex_material_sources(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CodexMaterialSourceStatus>, String> {
    inspect_codex_material_sources_with_state(&project_id, &state)
}

pub fn inspect_codex_material_sources_with_state(
    project_id: &str,
    state: &AppState,
) -> Result<Vec<CodexMaterialSourceStatus>, String> {
    let materials = state
        .database
        .codex()
        .list_materials(project_id)
        .map_err(|_| "无法读取项目资料。".to_owned())?;
    materials
        .iter()
        .map(|material| inspect_material_source(&state, material))
        .collect()
}

#[tauri::command]
pub fn refresh_codex_material(
    project_id: String,
    material_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CodexMaterial>, String> {
    refresh_codex_material_with_state(&project_id, &material_id, &state)
}

pub fn refresh_codex_material_with_state(
    project_id: &str,
    material_id: &str,
    state: &AppState,
) -> Result<Vec<CodexMaterial>, String> {
    let _mutation_lease = state
        .codex_runtime
        .reserve_project_mutation(project_id)
        .map_err(|_| "Codex 正在执行任务或修改项目资料，请稍后再刷新。".to_owned())?;
    let material = state
        .database
        .codex()
        .list_materials(project_id)
        .map_err(|_| "无法读取项目资料。".to_owned())?
        .into_iter()
        .find(|material| material.id == material_id)
        .ok_or_else(|| "没有找到要刷新的项目资料。".to_owned())?;
    let temporary;
    let source = match material.kind.as_str() {
        "local" => resolve_local_material_source(&state, &material)?,
        "ragflow_document" => {
            let metadata = material_metadata(&material)?;
            let dataset_id = metadata
                .get("datasetId")
                .and_then(Value::as_str)
                .ok_or_else(|| "RAGFlow 资料来源信息不完整。".to_owned())?;
            let document_id = metadata
                .get("documentId")
                .and_then(Value::as_str)
                .ok_or_else(|| "RAGFlow 资料来源信息不完整。".to_owned())?;
            let bytes =
                RagflowClient::from_saved_config(state.database.configs(), WindowsCredentialStore)?
                    .download_document(dataset_id, document_id)?;
            let layout = state
                .codex_runtime
                .project_files()
                .create_layout(project_id)
                .map_err(|_| "无法访问 Codex 项目目录。".to_owned())?;
            let directory = layout.staging.join(format!("refresh-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&directory)
                .map_err(|_| "无法暂存 RAGFlow 资料。".to_owned())?;
            temporary = directory.join(safe_refresh_name(&material.display_name));
            if std::fs::write(&temporary, bytes).is_err() {
                let _ = std::fs::remove_dir_all(&directory);
                return Err("无法暂存 RAGFlow 资料。".to_owned());
            }
            temporary.clone()
        }
        _ => return Err("该资料是检索时快照，不支持从来源刷新。".to_owned()),
    };
    let source_hash = match sha256_path(&source) {
        Ok(hash) => hash,
        Err(_) => {
            cleanup_temporary_refresh_source(&material, &source);
            return Err("无法读取资料来源。".to_owned());
        }
    };
    let current = material.current_version_id.as_deref().and_then(|id| {
        state
            .database
            .codex()
            .get_material_version(id)
            .ok()
            .flatten()
    });
    let original_only_confirmed = current.as_ref().is_some_and(|version| {
        version.derived_snapshot_path.is_none() && requires_derived_snapshot(&material.display_name)
    });
    if current
        .as_ref()
        .is_some_and(|version| version.content_hash == source_hash)
    {
        cleanup_temporary_refresh_source(&material, &source);
        return state
            .database
            .codex()
            .list_materials(project_id)
            .map_err(|_| "无法读取项目资料。".to_owned());
    }
    if let Some(existing) = state
        .database
        .codex()
        .find_project_material_version_by_hash(project_id, &source_hash)
        .map_err(|_| "无法读取资料版本。".to_owned())?
    {
        state
            .database
            .codex()
            .record_material_version(&CodexMaterialVersionInput {
                material_id: material.id.clone(),
                original_snapshot_path: existing.original_snapshot_path,
                derived_snapshot_path: existing.derived_snapshot_path,
                content_hash: existing.content_hash,
                size_bytes: existing.size_bytes,
                mime_type: existing.mime_type,
                extractor_version: existing.extractor_version,
                created_at_utc_ms: now_ms(),
            })
            .map_err(|_| "无法记录新的资料版本。".to_owned())?;
        cleanup_temporary_refresh_source(&material, &source);
        return state
            .database
            .codex()
            .list_materials(project_id)
            .map_err(|_| "无法读取项目资料。".to_owned());
    }
    let imported_result = state
        .codex_runtime
        .project_files()
        .snapshot_local_files_with_confirmations(
            project_id,
            &[source.clone()],
            true,
            original_only_confirmed,
        )
        .map_err(|error| error.to_string());
    cleanup_temporary_refresh_source(&material, &source);
    let imported = imported_result?;
    let item = imported
        .into_iter()
        .find(|item| item.status == crate::codex::MaterialImportStatus::Imported)
        .ok_or_else(|| "无法生成新的资料快照。".to_owned())?;
    if let Err(error) =
        record_refreshed_material_version(state, project_id, &material.id, &source, &item)
    {
        remove_imported_snapshot(&item);
        return Err(error);
    }
    state
        .database
        .codex()
        .list_materials(project_id)
        .map_err(|_| "无法读取项目资料。".to_owned())
}

#[tauri::command]
pub fn reveal_codex_material_source(
    project_id: String,
    material_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let material = state
        .database
        .codex()
        .list_materials(&project_id)
        .map_err(|_| "无法读取项目资料。".to_owned())?
        .into_iter()
        .find(|material| material.id == material_id)
        .ok_or_else(|| "没有找到项目资料。".to_owned())?;
    let source = resolve_local_material_source(&state, &material)?;
    launch_hidden(
        "explorer.exe",
        &[format!("/select,{}", source.to_string_lossy())],
    )
}

#[tauri::command]
pub fn import_codex_materials(
    input: ImportMaterialsInput,
    state: State<'_, AppState>,
) -> Result<Vec<CodexMaterial>, String> {
    if input.paths.is_empty() {
        return Err("请选择要加入项目的资料。".to_owned());
    }
    let _mutation_lease = state
        .codex_runtime
        .reserve_project_mutation(&input.project_id)
        .map_err(|_| "Codex 正在执行任务或修改项目资料，请稍后再添加。".to_owned())?;
    let paths = input.paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    if !input.confirm_large_files
        && paths.iter().any(|path| {
            std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > 50 * 1024 * 1024)
        })
    {
        return Err("需要确认复制超过 50 MB 的资料。".to_owned());
    }
    let imported = state
        .codex_runtime
        .project_files()
        .snapshot_local_files_with_confirmation(
            &input.project_id,
            &paths,
            input.confirm_large_files,
        )
        .map_err(|error| error.to_string())?;
    let layout = state
        .codex_runtime
        .project_files()
        .create_layout(&input.project_id)
        .map_err(|_| "无法访问项目目录。".to_owned())?;
    for item in imported
        .into_iter()
        .filter(|item| item.status == crate::codex::MaterialImportStatus::Imported)
    {
        let display_name = item
            .source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("资料");
        let material = state
            .database
            .codex()
            .create_material(
                &input.project_id,
                "local",
                display_name,
                Some(&item.source_path.to_string_lossy()),
                now_ms(),
            )
            .map_err(|_| "无法记录项目资料。".to_owned())?;
        let original = item
            .original_snapshot_path
            .as_ref()
            .and_then(|path| path.strip_prefix(&layout.root).ok())
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .ok_or_else(|| "资料快照路径无效。".to_owned())?;
        let derived = item
            .derived_snapshot_path
            .as_ref()
            .and_then(|path| path.strip_prefix(&layout.root).ok())
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        state
            .database
            .codex()
            .record_material_version(&CodexMaterialVersionInput {
                material_id: material.id,
                original_snapshot_path: original,
                derived_snapshot_path: derived,
                content_hash: item.content_hash.unwrap_or_default(),
                size_bytes: item.size_bytes as i64,
                mime_type: "application/octet-stream".to_owned(),
                extractor_version: Some("qizhi-1".to_owned()),
                created_at_utc_ms: now_ms(),
            })
            .map_err(|_| "无法记录资料版本。".to_owned())?;
    }
    state
        .database
        .codex()
        .list_materials(&input.project_id)
        .map_err(|_| "无法读取项目资料。".to_owned())
}

#[tauri::command]
pub fn remove_codex_material(
    project_id: String,
    material_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CodexMaterial>, String> {
    remove_codex_material_with_state(&project_id, &material_id, &state)
}

pub fn remove_codex_material_with_state(
    project_id: &str,
    material_id: &str,
    state: &AppState,
) -> Result<Vec<CodexMaterial>, String> {
    let _mutation_lease = state
        .codex_runtime
        .reserve_project_mutation(project_id)
        .map_err(|_| "Codex 正在执行任务或修改项目资料，请稍后再移除。".to_owned())?;
    let belongs = state
        .database
        .codex()
        .list_materials(project_id)
        .map_err(|_| "无法读取项目资料。".to_owned())?
        .iter()
        .any(|material| material.id == material_id);
    if !belongs {
        return Err("没有找到要移除的项目资料。".to_owned());
    }
    state
        .database
        .codex()
        .set_material_state(material_id, "removed")
        .map_err(|_| "无法移除项目资料。".to_owned())?;
    state
        .database
        .codex()
        .list_materials(project_id)
        .map_err(|_| "无法读取项目资料。".to_owned())
}

#[tauri::command]
pub fn list_codex_artifacts(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CodexArtifact>, String> {
    state
        .database
        .codex()
        .list_artifacts(&project_id)
        .map_err(|_| "无法读取生成物。".to_owned())
}

#[tauri::command]
pub fn open_codex_artifact(
    project_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = artifact_path(&state, &project_id, &relative_path)?;
    launch_hidden("explorer.exe", &[path.to_string_lossy().into_owned()])
}

#[tauri::command]
pub fn reveal_codex_artifact(
    project_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = artifact_path(&state, &project_id, &relative_path)?;
    launch_hidden(
        "explorer.exe",
        &[format!("/select,{}", path.to_string_lossy())],
    )
}

#[tauri::command]
pub fn export_codex_artifact(
    project_id: String,
    relative_path: String,
    destination: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let source = artifact_path(&state, &project_id, &relative_path)?;
    let destination = PathBuf::from(destination);
    if destination.as_os_str().is_empty() || destination.is_dir() {
        return Err("请选择有效的保存位置。".to_owned());
    }
    std::fs::copy(source, destination)
        .map(|_| ())
        .map_err(|_| "无法导出生成物。".to_owned())
}

#[tauri::command]
pub fn start_codex_turn(
    mut input: StartCodexTurnInput,
    on_event: Channel<CodexTurnEvent>,
    state: State<'_, AppState>,
) -> Result<CodexTurnResult, String> {
    if let Ok(preferences) = state.database.codex().get_preferences() {
        if input.model.as_deref().is_none_or(str::is_empty) && !preferences.model.is_empty() {
            input.model = Some(preferences.model);
        }
        if input.reasoning_effort.is_none() {
            input.reasoning_effort = Some(preferences.reasoning_effort);
        }
    }
    state
        .codex_runtime
        .start_turn(
            input,
            Arc::new(move |event| {
                let _ = on_event.send(event);
            }),
        )
        .map_err(user_runtime_error)
}

#[tauri::command]
pub fn interrupt_codex_turn(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .codex_runtime
        .interrupt_turn(&project_id)
        .map_err(user_runtime_error)
}

#[tauri::command]
pub fn resolve_codex_approval(
    request_id: String,
    decision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .codex_runtime
        .resolve_approval(request_id, &decision)
        .map_err(user_runtime_error)
}

fn inspect_material_source(
    state: &AppState,
    material: &CodexMaterial,
) -> Result<CodexMaterialSourceStatus, String> {
    match material.kind.as_str() {
        "local" => match resolve_local_material_source(state, material) {
            Ok(path) => {
                let current_version = material.current_version_id.as_deref().and_then(|id| {
                    state
                        .database
                        .codex()
                        .get_material_version(id)
                        .ok()
                        .flatten()
                });
                let current_hash = current_version
                    .as_ref()
                    .map(|version| version.content_hash.clone());
                let actual_hash = sha256_path(&path).ok();
                let original_only = current_version.as_ref().is_some_and(|version| {
                    version.derived_snapshot_path.is_none()
                        && requires_derived_snapshot(&material.display_name)
                });
                Ok(CodexMaterialSourceStatus {
                    material_id: material.id.clone(),
                    state: if current_hash.is_none() || current_hash != actual_hash {
                        "source_changed"
                    } else if original_only {
                        "original_only"
                    } else {
                        "ready"
                    }
                    .to_owned(),
                    source_label: path.to_string_lossy().into_owned(),
                    refreshable: true,
                    revealable: true,
                })
            }
            Err(_) => Ok(CodexMaterialSourceStatus {
                material_id: material.id.clone(),
                state: "source_missing".to_owned(),
                source_label: "原文件已移动或删除".to_owned(),
                refreshable: false,
                revealable: false,
            }),
        },
        "ragflow_document" => Ok(CodexMaterialSourceStatus {
            material_id: material.id.clone(),
            state: "ready".to_owned(),
            source_label: "RAGFlow 原文档".to_owned(),
            refreshable: true,
            revealable: false,
        }),
        "ragflow_chunk" | "ragflow_answer" => Ok(CodexMaterialSourceStatus {
            material_id: material.id.clone(),
            state: "snapshot_only".to_owned(),
            source_label: if material.kind == "ragflow_chunk" {
                "RAGFlow 检索片段"
            } else {
                "RAGFlow Agent 回答"
            }
            .to_owned(),
            refreshable: false,
            revealable: false,
        }),
        _ => Ok(CodexMaterialSourceStatus {
            material_id: material.id.clone(),
            state: "ready".to_owned(),
            source_label: "项目快照".to_owned(),
            refreshable: false,
            revealable: false,
        }),
    }
}

fn cleanup_temporary_refresh_source(material: &CodexMaterial, source: &Path) {
    if material.kind == "ragflow_document" {
        if let Some(parent) = source.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
}

fn requires_derived_snapshot(display_name: &str) -> bool {
    matches!(
        Path::new(display_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "pdf" | "docx" | "xlsx" | "pptx" | "rtf" | "odt" | "ods" | "odp"
    )
}

fn resolve_local_material_source(
    state: &AppState,
    material: &CodexMaterial,
) -> Result<PathBuf, String> {
    if let Ok(metadata) = material_metadata(material)
        && let Some(file_id) = metadata.get("fileId").and_then(Value::as_i64)
        && let Some(record) = state
            .database
            .files()
            .get_by_id(file_id)
            .map_err(|_| "无法读取原文件。".to_owned())?
    {
        let path = PathBuf::from(record.canonical_path);
        if path.is_file() {
            return Ok(path);
        }
    }
    let origin = material
        .origin_reference
        .as_deref()
        .filter(|value| !value.starts_with("local:"))
        .ok_or_else(|| "原文件已经不存在。".to_owned())?;
    let path = PathBuf::from(origin);
    if path.is_file() {
        Ok(path)
    } else {
        Err("原文件已经不存在。".to_owned())
    }
}

fn material_metadata(material: &CodexMaterial) -> Result<Value, String> {
    material
        .source_metadata_json
        .as_deref()
        .ok_or_else(|| "资料来源信息不完整。".to_owned())
        .and_then(|value| {
            serde_json::from_str(value).map_err(|_| "资料来源信息无法识别。".to_owned())
        })
}

fn safe_refresh_name(value: &str) -> String {
    let name = value
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if name.trim().is_empty() {
        "material.bin".to_owned()
    } else {
        name
    }
}

fn record_refreshed_material_version(
    state: &AppState,
    project_id: &str,
    material_id: &str,
    source: &Path,
    item: &crate::codex::MaterialImportResult,
) -> Result<(), String> {
    let layout = state
        .codex_runtime
        .project_files()
        .create_layout(project_id)
        .map_err(|_| "无法访问项目目录。".to_owned())?;
    let original = item
        .original_snapshot_path
        .as_ref()
        .and_then(|path| path.strip_prefix(&layout.root).ok())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .ok_or_else(|| "资料快照路径无效。".to_owned())?;
    let derived = item
        .derived_snapshot_path
        .as_ref()
        .and_then(|path| path.strip_prefix(&layout.root).ok())
        .map(|path| path.to_string_lossy().replace('\\', "/"));
    state
        .database
        .codex()
        .record_material_version(&CodexMaterialVersionInput {
            material_id: material_id.to_owned(),
            original_snapshot_path: original,
            derived_snapshot_path: derived,
            content_hash: item.content_hash.clone().unwrap_or_default(),
            size_bytes: item.size_bytes as i64,
            mime_type: mime_type_for_path(source),
            extractor_version: Some("qizhi-1".to_owned()),
            created_at_utc_ms: now_ms(),
        })
        .map(|_| ())
        .map_err(|_| "无法记录新的资料版本。".to_owned())
}

fn remove_imported_snapshot(item: &crate::codex::MaterialImportResult) {
    if let Some(path) = &item.original_snapshot_path {
        let _ = std::fs::remove_file(path);
    }
    if let Some(path) = &item.derived_snapshot_path {
        let _ = std::fs::remove_file(path);
    }
}

fn sha256_path(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "无法读取原文件。".to_owned())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "无法读取原文件。".to_owned())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn mime_type_for_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
    .to_owned()
}

fn user_runtime_error(error: crate::codex::CodexRuntimeError) -> String {
    match error {
        crate::codex::CodexRuntimeError::NotInstalled => {
            "未检测到本机 Codex，请先安装 Codex 后重试。".to_owned()
        }
        crate::codex::CodexRuntimeError::UnsupportedVersion => {
            "本机 Codex 版本不受支持，请更新后重试。".to_owned()
        }
        crate::codex::CodexRuntimeError::RequestTimeout => {
            "Codex 响应超时，请稍后重试。".to_owned()
        }
        crate::codex::CodexRuntimeError::ProcessExited => {
            "Codex 服务已中断，请重新进入项目。".to_owned()
        }
        _ => "Codex 暂时无法完成此操作。".to_owned(),
    }
}

fn artifact_path(
    state: &AppState,
    project_id: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let path = state
        .codex_runtime
        .project_files()
        .resolve_workspace_path(project_id, std::path::Path::new(relative_path))
        .map_err(|_| "生成物路径无效。".to_owned())?;
    if !path.is_file() {
        return Err("生成物已经不存在。".to_owned());
    }
    Ok(path)
}

fn launch_hidden(program: &str, arguments: &[String]) -> Result<(), String> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法打开生成物。".to_owned())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}
