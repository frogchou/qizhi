use std::{collections::BTreeSet, fs::OpenOptions, io::Write, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{State, ipc::Channel};

use crate::{
    app_state::AppState,
    config::secret_store::WindowsCredentialStore,
    contracts::{SummarySettings, SummarySettingsInput},
    openai::{
        OpenAiClient, SummaryFileInput, SummaryGeneration,
        content::{extract_summary_text_from_bytes, mime_type},
    },
    ragflow::client::{RagflowClient, RagflowUpload},
    scan::{
        file_filter::FileTypeFilter,
        policy::{ScanPolicy, active_roots},
    },
};

const MAX_FILES: usize = 20;
const MAX_RAW_BYTES: u64 = 40 * 1024 * 1024;
const MAX_LOCAL_CHARS: usize = 180_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateWorkSummaryInput {
    #[serde(default)]
    pub query_id: Option<String>,
    #[serde(default)]
    pub file_ids: Vec<i64>,
    #[serde(default)]
    pub directory_ids: Vec<String>,
    pub template_id: i64,
    #[serde(default)]
    pub confirmed_multi_batch: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSummarySelectionInput {
    pub query_id: Option<String>,
    #[serde(default)]
    pub file_ids: Vec<i64>,
    #[serde(default)]
    pub directory_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSummaryPreparation {
    pub file_count: usize,
    pub batch_count: usize,
    pub requires_confirmation: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateWorkSummaryOutput {
    pub markdown: String,
    pub truncated: bool,
    pub file_count: usize,
    pub template_title: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkSummaryStreamEvent {
    Started {
        template_title: String,
        file_count: usize,
    },
    Delta {
        delta: String,
    },
    BatchProgress {
        current: usize,
        total: usize,
        phase: String,
    },
    Completed {
        truncated: bool,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSummaryMarkdownInput {
    pub content: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSummaryMarkdownOutput {
    pub saved_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSummaryMarkdownInput {
    pub content: String,
    pub filename: String,
    pub dataset_id: String,
    pub parent_path: Option<String>,
    pub start_parsing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryUploadOutput {
    pub document_ids: Vec<String>,
    pub document_count: usize,
    pub parsing_started: bool,
    pub parsing_error: Option<String>,
}

pub fn validate_summary_limits(file_ids: &[i64], total_bytes: u64) -> Result<(), String> {
    if file_ids.is_empty() {
        return Err("请先勾选需要总结的文件。".to_owned());
    }
    if file_ids.len() > MAX_FILES {
        return Err(format!("单次最多总结 {MAX_FILES} 个文件。"));
    }
    if total_bytes > MAX_RAW_BYTES {
        return Err("所选文件合计超过 40 MB，请减少文件数量。".to_owned());
    }
    Ok(())
}

pub fn plan_summary_batches(file_ids: &[i64]) -> Vec<Vec<i64>> {
    let unique = file_ids.iter().copied().collect::<BTreeSet<_>>();
    unique
        .into_iter()
        .collect::<Vec<_>>()
        .chunks(MAX_FILES)
        .map(<[i64]>::to_vec)
        .collect()
}

fn preparation(file_ids: &[i64]) -> WorkSummaryPreparation {
    let batches = plan_summary_batches(file_ids);
    WorkSummaryPreparation {
        file_count: batches.iter().map(Vec::len).sum(),
        batch_count: batches.len(),
        requires_confirmation: batches.len() > 1,
    }
}

pub fn compose_summary_artifact(markdown: &str, truncated: bool) -> String {
    compose_summary_artifact_with_input_state(markdown, truncated, false)
}

pub fn compose_summary_artifact_with_input_state(
    markdown: &str,
    truncated: bool,
    input_truncated: bool,
) -> String {
    let mut parts = Vec::new();
    if input_truncated {
        parts.push("> ⚠️ 部分文件内容因本地回退长度限制已截断。");
    }
    if truncated {
        parts.push("> ⚠️ OpenAI 标记本次输出不完整，以下内容可能缺失。");
    }
    parts.push(markdown.trim());
    parts.join("\n\n")
}

pub fn safe_summary_filename(value: &str) -> String {
    let stem = value
        .trim()
        .strip_suffix(".md")
        .or_else(|| value.trim().strip_suffix(".MD"))
        .unwrap_or(value.trim());
    let mut safe = stem
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(100)
        .collect::<String>();
    safe = safe.trim_matches([' ', '.']).to_owned();
    if safe.is_empty() {
        safe = "今日总结".to_owned();
    }
    format!("{safe}.md")
}

pub fn bound_local_summary_text(text: &str, used: &mut usize, limit: usize) -> String {
    let remaining = limit.saturating_sub(*used);
    let total = text.chars().count();
    let kept = total.min(remaining);
    *used = used.saturating_add(kept);
    let mut bounded = text.chars().take(kept).collect::<String>();
    if kept < total {
        bounded.push_str("\n\n[内容已截断：所选文件的本地回退文本达到安全长度上限]");
    }
    bounded
}

#[tauri::command]
pub fn get_summary_settings(state: State<'_, AppState>) -> Result<SummarySettings, String> {
    state
        .database
        .summary_settings()
        .get()
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn save_summary_settings(
    state: State<'_, AppState>,
    input: SummarySettingsInput,
) -> Result<SummarySettings, String> {
    state
        .database
        .summary_settings()
        .save(&input)
        .map_err(|error| error.code().to_owned())?;
    state
        .database
        .summary_settings()
        .get()
        .map_err(|error| error.code().to_owned())
}

pub fn prepare_summary(
    state: &AppState,
    input: WorkSummarySelectionInput,
) -> Result<WorkSummaryPreparation, String> {
    let file_ids = resolve_summary_selection(state, &input)?;
    if file_ids.is_empty() {
        return Err("所选范围中没有仍可访问的文件。".to_owned());
    }
    Ok(preparation(&file_ids))
}

#[tauri::command]
pub fn prepare_work_summary(
    state: State<'_, AppState>,
    input: WorkSummarySelectionInput,
) -> Result<WorkSummaryPreparation, String> {
    prepare_summary(&state, input)
}

fn resolve_summary_selection(
    state: &AppState,
    input: &WorkSummarySelectionInput,
) -> Result<Vec<i64>, String> {
    if let Some(query_id) = input.query_id.as_deref() {
        return super::today::resolve_workspace_selection(
            state,
            super::today::WorkspaceSelectionInput {
                query_id: query_id.to_owned(),
                file_ids: input.file_ids.clone(),
                directory_ids: input.directory_ids.clone(),
            },
        )
        .map(|output| output.file_ids);
    }
    let rules = state
        .scan_rules
        .get()
        .map_err(|_| "无法读取扫描规则。".to_owned())?;
    let exclusions = rules
        .custom_exclusions
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let roots = active_roots(&rules.allowed_roots, &exclusions)
        .map_err(|_| "扫描目录无效，请在设置中重新保存。".to_owned())?;
    let policy = ScanPolicy::for_roots(exclusions, roots);
    let filter = FileTypeFilter::new(rules.file_categories);
    let repository = state.database.files();
    let mut safe = BTreeSet::new();
    for id in &input.file_ids {
        let Some(file) = repository
            .get_by_id(*id)
            .map_err(|_| "无法读取所选文件。".to_owned())?
        else {
            continue;
        };
        let path = PathBuf::from(file.canonical_path);
        if filter.allows(&path) && policy.is_allowed(&path) {
            safe.insert(file.id);
        }
    }
    Ok(safe.into_iter().collect())
}

#[tauri::command]
pub async fn generate_work_summary(
    state: State<'_, AppState>,
    input: GenerateWorkSummaryInput,
    on_event: Channel<WorkSummaryStreamEvent>,
) -> Result<GenerateWorkSummaryOutput, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = generate(&state, input, |event| {
            let _ = on_event.send(event);
        });
        match &result {
            Ok(output) => state.logger.info(
                "summary",
                &format!(
                    "work summary generated from {} file(s), truncated={}",
                    output.file_count, output.truncated
                ),
            ),
            Err(error) => state.logger.error(
                "summary",
                &format!("work summary generation failed: {error}"),
            ),
        }
        result
    })
    .await
    .map_err(|_| "生成今日总结时发生意外错误。".to_owned())?
}

fn generate<E>(
    state: &AppState,
    input: GenerateWorkSummaryInput,
    emit: E,
) -> Result<GenerateWorkSummaryOutput, String>
where
    E: Fn(WorkSummaryStreamEvent),
{
    let selected = resolve_summary_selection(
        state,
        &WorkSummarySelectionInput {
            query_id: input.query_id.clone(),
            file_ids: input.file_ids.clone(),
            directory_ids: input.directory_ids.clone(),
        },
    )?;
    let batches = plan_summary_batches(&selected);
    if batches.is_empty() {
        return Err("所选范围中没有仍可访问的文件。".to_owned());
    }
    if batches.len() > 1 && !input.confirmed_multi_batch {
        return Err(format!(
            "所选 {} 个文件需要分 {} 批总结，请先确认。",
            selected.len(),
            batches.len()
        ));
    }
    let settings = state
        .database
        .summary_settings()
        .get()
        .map_err(|_| "无法读取总结设置。".to_owned())?;
    let template = settings
        .templates
        .iter()
        .find(|item| item.id == input.template_id)
        .ok_or_else(|| "所选总结方式已被删除，请重新选择。".to_owned())?
        .clone();
    emit(WorkSummaryStreamEvent::Started {
        template_title: template.title.clone(),
        file_count: selected.len(),
    });
    let client = OpenAiClient::from_saved_config(
        state.database.configs(),
        WindowsCredentialStore,
        settings.model,
    )?;
    let generated = if batches.len() == 1 {
        let files = load_summary_files(state, &batches[0])?;
        generate_from_files(&client, &template.prompt, &files, |delta| {
            emit(WorkSummaryStreamEvent::Delta {
                delta: delta.to_owned(),
            });
            Ok(())
        })?
    } else {
        let mut batch_summaries = Vec::with_capacity(batches.len());
        for (index, batch) in batches.iter().enumerate() {
            emit(WorkSummaryStreamEvent::BatchProgress {
                current: index + 1,
                total: batches.len(),
                phase: "summarizing".to_owned(),
            });
            let files = load_summary_files(state, batch)?;
            let result = generate_from_files(&client, &template.prompt, &files, |_| Ok(()))?;
            batch_summaries.push(SummaryFileInput {
                name: format!("第{}批总结.md", index + 1),
                mime_type: "text/markdown".to_owned(),
                bytes: compose_summary_artifact_with_input_state(
                    &result.markdown,
                    result.truncated,
                    result.used_local_fallback && result.input_truncated,
                )
                .into_bytes(),
            });
        }
        let mut synthesis_level = 1_usize;
        while batch_summaries.len() > MAX_FILES {
            let mut next_level = Vec::with_capacity(batch_summaries.len().div_ceil(MAX_FILES));
            for (index, group) in batch_summaries.chunks(MAX_FILES).enumerate() {
                let prompt = format!(
                    "{}\n\n以下是第 {} 层的一组中间总结。请合并、去重并保留所有事实、不确定项和失败信息，只输出 Markdown。",
                    template.prompt, synthesis_level
                );
                let result = generate_from_files(&client, &prompt, group, |_| Ok(()))?;
                next_level.push(SummaryFileInput {
                    name: format!("第{}层-第{}组总结.md", synthesis_level, index + 1),
                    mime_type: "text/markdown".to_owned(),
                    bytes: compose_summary_artifact_with_input_state(
                        &result.markdown,
                        result.truncated,
                        result.used_local_fallback && result.input_truncated,
                    )
                    .into_bytes(),
                });
            }
            batch_summaries = next_level;
            synthesis_level += 1;
        }
        emit(WorkSummaryStreamEvent::BatchProgress {
            current: batches.len(),
            total: batches.len(),
            phase: "synthesizing".to_owned(),
        });
        let synthesis_prompt = format!(
            "{}\n\n以下文件是各批次的中间总结。请综合为一份完整、去重、结构清晰的最终 Markdown；不得遗漏批次中的失败或不确定信息。",
            template.prompt
        );
        generate_from_files(&client, &synthesis_prompt, &batch_summaries, |delta| {
            emit(WorkSummaryStreamEvent::Delta {
                delta: delta.to_owned(),
            });
            Ok(())
        })?
    };
    emit(WorkSummaryStreamEvent::Completed {
        truncated: generated.truncated,
    });
    Ok(GenerateWorkSummaryOutput {
        markdown: compose_summary_artifact_with_input_state(
            &generated.markdown,
            generated.truncated,
            generated.used_local_fallback && generated.input_truncated,
        ),
        truncated: generated.truncated,
        file_count: selected.len(),
        template_title: template.title.clone(),
    })
}

fn load_summary_files(state: &AppState, file_ids: &[i64]) -> Result<Vec<SummaryFileInput>, String> {
    let rules = state
        .scan_rules
        .get()
        .map_err(|_| "无法读取扫描规则。".to_owned())?;
    let exclusions = rules
        .custom_exclusions
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let roots = active_roots(&rules.allowed_roots, &exclusions)
        .map_err(|_| "扫描目录无效，请在设置中重新保存。".to_owned())?;
    let policy = ScanPolicy::for_roots(exclusions, roots);
    let filter = FileTypeFilter::new(rules.file_categories);
    let mut total_bytes = 0_u64;
    let mut files = Vec::with_capacity(file_ids.len());
    for id in file_ids {
        let file = state
            .database
            .files()
            .get_by_id(*id)
            .map_err(|_| "无法读取所选文件。".to_owned())?
            .ok_or_else(|| "所选文件已不在列表中，请刷新后重试。".to_owned())?;
        let path = PathBuf::from(&file.canonical_path);
        if !policy.is_allowed(&path) || !filter.allows(&path) {
            return Err("所选文件已不在允许扫描范围内。".to_owned());
        }
        let metadata =
            std::fs::metadata(&path).map_err(|_| "所选文件可能已移动或无法访问。".to_owned())?;
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "所选文件合计过大。".to_owned())?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "文件名无法识别。".to_owned())?
            .to_owned();
        files.push(SummaryFileInput {
            name,
            mime_type: mime_type(&path).to_owned(),
            bytes: std::fs::read(path).map_err(|_| "无法读取所选文件内容。".to_owned())?,
        });
    }
    validate_summary_limits(file_ids, total_bytes)?;
    Ok(files)
}

fn generate_from_files<D>(
    client: &OpenAiClient,
    prompt: &str,
    files: &[SummaryFileInput],
    on_delta: D,
) -> Result<SummaryGeneration, String>
where
    D: FnMut(&str) -> Result<(), String>,
{
    client.generate_streaming(
        prompt,
        files,
        || {
            let mut local_text = Vec::with_capacity(files.len());
            let mut local_chars = 0_usize;
            for file in files {
                let extension = PathBuf::from(&file.name)
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_owned();
                let text = extract_summary_text_from_bytes(&file.bytes, &extension)?;
                local_text.push((
                    file.name.clone(),
                    bound_local_summary_text(&text, &mut local_chars, MAX_LOCAL_CHARS),
                ));
            }
            Ok(local_text)
        },
        on_delta,
    )
}

#[tauri::command]
pub fn save_summary_markdown(
    input: SaveSummaryMarkdownInput,
) -> Result<SaveSummaryMarkdownOutput, String> {
    let destination = PathBuf::from(input.path.trim());
    if input.content.trim().is_empty()
        || destination
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("md"))
        || destination.parent().is_none_or(|parent| !parent.exists())
    {
        return Err("请选择有效的 Markdown 保存位置。".to_owned());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&destination)
        .map_err(|_| "无法创建总结文件，请检查保存位置。".to_owned())?;
    file.write_all(input.content.as_bytes())
        .map_err(|_| "无法写入总结文件。".to_owned())?;
    Ok(SaveSummaryMarkdownOutput {
        saved_path: destination.display().to_string(),
    })
}

#[tauri::command]
pub async fn upload_summary_markdown(
    state: State<'_, AppState>,
    input: UploadSummaryMarkdownInput,
) -> Result<SummaryUploadOutput, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if input.content.trim().is_empty() || input.content.len() > 5 * 1024 * 1024 {
            return Err("总结内容为空或过大，无法上传。".to_owned());
        }
        let filename = safe_summary_filename(&input.filename);
        let RagflowUpload {
            document_ids,
            document_count,
            parsing_started,
            parsing_error,
        } = RagflowClient::from_saved_config(state.database.configs(), WindowsCredentialStore)?
            .upload_markdown(
                &filename,
                input.content.as_bytes(),
                input.dataset_id.trim(),
                input.parent_path.as_deref(),
                input.start_parsing,
            )?;
        Ok(SummaryUploadOutput {
            document_ids,
            document_count,
            parsing_started,
            parsing_error,
        })
    })
    .await
    .map_err(|_| "上传总结时发生意外错误。".to_owned())?
}
