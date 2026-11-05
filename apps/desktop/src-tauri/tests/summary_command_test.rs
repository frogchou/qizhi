use qizhi_desktop_lib::commands::summary::{
    WorkSummaryStreamEvent, bound_local_summary_text, compose_summary_artifact,
    compose_summary_artifact_with_input_state, plan_summary_batches, safe_summary_filename,
    validate_summary_limits,
};

#[test]
fn prepends_a_warning_to_truncated_summary_artifacts() {
    let artifact = compose_summary_artifact("# 今日总结\n完成索引。", true);

    assert!(artifact.starts_with("> ⚠️ OpenAI 标记本次输出不完整，以下内容可能缺失。"));
    assert!(artifact.contains("# 今日总结"));
}

#[test]
fn plans_stable_deduplicated_batches_of_at_most_twenty_files() {
    let twenty = (1..=20).collect::<Vec<_>>();
    assert_eq!(plan_summary_batches(&twenty), vec![twenty]);

    let mut twenty_one = (1..=21).rev().collect::<Vec<_>>();
    twenty_one.push(1);
    let batches = plan_summary_batches(&twenty_one);
    assert_eq!(batches.len(), 2);
    assert_eq!(batches[0].len(), 20);
    assert_eq!(batches[1], vec![21]);
}

#[test]
fn includes_a_visible_warning_when_local_fallback_input_was_truncated() {
    let artifact = compose_summary_artifact_with_input_state("# 总结", false, true);

    assert!(artifact.starts_with("> ⚠️ 部分文件内容因本地回退长度限制已截断。"));
}

#[test]
fn keeps_every_selected_file_in_the_local_fallback_and_marks_truncation() {
    let mut used = 4;
    let text = bound_local_summary_text("abcdefgh", &mut used, 7);

    assert!(text.starts_with("abc"));
    assert!(text.contains("内容已截断"));
    assert_eq!(used, 7);
}

#[test]
fn validates_selection_before_loading_file_contents() {
    assert!(validate_summary_limits(&vec![1; 21], 100).is_err());
    assert!(validate_summary_limits(&[1, 2], 40 * 1024 * 1024 + 1).is_err());
    assert!(validate_summary_limits(&[1, 2], 1024).is_ok());
}

#[test]
fn sanitizes_summary_artifact_filenames_for_windows_and_multipart() {
    assert_eq!(
        safe_summary_filename("项目/复盘:\"最终\".md"),
        "项目_复盘__最终_.md"
    );
    assert_eq!(safe_summary_filename("..."), "今日总结.md");
}

#[test]
fn serializes_work_summary_stream_events_for_the_frontend_channel() {
    assert_eq!(
        serde_json::to_value(WorkSummaryStreamEvent::Started {
            template_title: "会议总结".to_owned(),
            file_count: 2,
        })
        .expect("started serializes"),
        serde_json::json!({
            "kind": "started",
            "templateTitle": "会议总结",
            "fileCount": 2
        })
    );
    assert_eq!(
        serde_json::to_value(WorkSummaryStreamEvent::Delta {
            delta: "# 结论".to_owned(),
        })
        .expect("delta serializes"),
        serde_json::json!({"kind": "delta", "delta": "# 结论"})
    );
    assert_eq!(
        serde_json::to_value(WorkSummaryStreamEvent::BatchProgress {
            current: 2,
            total: 3,
            phase: "summarizing".to_owned(),
        })
        .expect("batch progress serializes"),
        serde_json::json!({
            "kind": "batchProgress",
            "current": 2,
            "total": 3,
            "phase": "summarizing"
        })
    );
    assert_eq!(
        serde_json::to_value(WorkSummaryStreamEvent::Completed { truncated: true })
            .expect("completed serializes"),
        serde_json::json!({"kind": "completed", "truncated": true})
    );
}
