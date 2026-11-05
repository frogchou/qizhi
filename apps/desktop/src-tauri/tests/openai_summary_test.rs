use qizhi_desktop_lib::openai::content::{extract_summary_text, extract_summary_text_from_bytes};
use qizhi_desktop_lib::openai::{
    SummaryFileInput, build_chat_fallback_request, build_direct_request, openai_api_url,
    parse_chat_summary_response, parse_summary_response, parse_summary_response_with_deltas,
    should_fallback_to_local,
};

#[test]
fn builds_a_responses_request_with_file_inputs() {
    let body = build_direct_request(
        "gpt-5.6",
        "总结成果。",
        &[SummaryFileInput {
            name: "周报.md".to_owned(),
            mime_type: "text/markdown".to_owned(),
            bytes: b"done".to_vec(),
        }],
    )
    .expect("request builds");
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid json");

    assert_eq!(json["model"], "gpt-5.6");
    assert_eq!(json["stream"], true);
    assert!(json["instructions"].as_str().unwrap().contains("不得虚构"));
    assert_eq!(json["input"][0]["content"][1]["type"], "input_file");
    assert!(
        json["input"][0]["content"][1]["file_data"]
            .as_str()
            .expect("file data")
            .starts_with("data:text/markdown;base64,")
    );
}

#[test]
fn marks_per_file_text_that_is_truncated_for_local_fallback() {
    let path = std::env::temp_dir().join(format!(
        "qizhi-summary-long-{}.md",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::write(&path, "a".repeat(50_100)).expect("fixture writes");

    let text = extract_summary_text(&path).expect("text extracts");

    assert!(text.contains("内容已截断"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn adds_the_standard_v1_prefix_when_the_saved_base_url_has_no_path() {
    assert_eq!(
        openai_api_url("https://proxy.example", "responses").expect("url"),
        "https://proxy.example/v1/responses"
    );
    assert_eq!(
        openai_api_url(" https://api.openai.com/v1/ ", "responses").expect("url"),
        "https://api.openai.com/v1/responses"
    );
}

#[test]
fn local_text_fallback_uses_chat_completions_shape() {
    let body = build_chat_fallback_request(
        "gpt-5.6",
        "总结成果。",
        &[("周报.md".to_owned(), "完成索引".to_owned())],
    )
    .expect("fallback request builds");
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid json");
    assert!(json.get("messages").is_some());
    assert_eq!(json["messages"][0]["role"], "developer");
    assert!(
        json["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("仅依据用户选择的文件")
    );
    assert!(json.get("input").is_none());

    let parsed = parse_chat_summary_response(
        r##"{"choices":[{"finish_reason":"length","message":{"content":"# 总结"}}]}"##,
    )
    .expect("chat response parses");
    assert_eq!(parsed.markdown, "# 总结");
    assert!(parsed.truncated);
}

#[test]
fn parses_output_text_and_marks_incomplete_responses() {
    let body = r##"{
      "status":"incomplete",
      "incomplete_details":{"reason":"max_output_tokens"},
      "output":[{"type":"message","content":[{"type":"output_text","text":"# 总结\n完成了索引。"}]}]
    }"##;

    let result = parse_summary_response(body).expect("response parses");

    assert!(result.markdown.contains("完成了索引"));
    assert!(result.truncated);

    let filtered = parse_summary_response(
        r##"{"status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[{"content":[{"type":"output_text","text":"# 部分结果"}]}]}"##,
    )
    .expect("other incomplete response parses");
    assert!(filtered.truncated);
}

#[test]
fn parses_streamed_responses_output_text_events() {
    let body = concat!(
        "event: response.created\n",
        "data: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\"}}\n\n",
        "event: response.output_text.delta\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"# 总\"}\n\n",
        "event: response.output_text.delta\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"结\\n完成索引。\"}\n\n",
        "event: response.completed\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
        "data: [DONE]\n\n"
    );

    let parsed = parse_summary_response(body).expect("stream response parses");

    assert_eq!(parsed.markdown, "# 总结\n完成索引。");
    assert!(!parsed.truncated);
}

#[test]
fn emits_each_responses_delta_once_and_in_order() {
    let body = concat!(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"# 总\"}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"结\\n\"}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"- 完成索引\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
    );
    let mut deltas = Vec::new();

    let parsed = parse_summary_response_with_deltas(body, |delta| {
        deltas.push(delta.to_owned());
        Ok(())
    })
    .expect("stream parses");

    assert_eq!(deltas, ["# 总", "结\n", "- 完成索引"]);
    assert_eq!(parsed.markdown, "# 总结\n- 完成索引");
}

#[test]
fn emits_the_complete_text_once_when_a_provider_returns_json() {
    let body = r##"{"status":"completed","output":[{"content":[{"type":"output_text","text":"# 总结\n\n完成了索引。"}]}]}"##;
    let mut deltas = Vec::new();

    let parsed = parse_summary_response_with_deltas(body, |delta| {
        deltas.push(delta.to_owned());
        Ok(())
    })
    .expect("json response parses");

    assert_eq!(deltas.len(), 1);
    assert_eq!(deltas[0], "# 总结\n\n完成了索引。");
    assert_eq!(parsed.markdown, "# 总结\n\n完成了索引。");
}

#[test]
fn preserves_emitted_text_but_returns_an_error_when_the_stream_fails() {
    let body = concat!(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"已生成部分\"}\n\n",
        "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n"
    );
    let mut deltas = Vec::new();

    let error = parse_summary_response_with_deltas(body, |delta| {
        deltas.push(delta.to_owned());
        Ok(())
    })
    .expect_err("failed stream is rejected");

    assert_eq!(deltas, ["已生成部分"]);
    assert_eq!(error, "OpenAI 生成总结失败。");
}

#[test]
fn only_falls_back_for_explicit_file_input_incompatibility() {
    assert!(should_fallback_to_local(415, "unsupported media type"));
    assert!(should_fallback_to_local(404, "Not Found"));
    assert!(should_fallback_to_local(
        400,
        r#"{"error":{"code":"unsupported_parameter","param":"input[0].content[1].file_data","message":"input_file is not supported"}}"#
    ));

    assert!(!should_fallback_to_local(
        404,
        r#"{"error":{"code":"model_not_found","message":"model not found"}}"#
    ));
    assert!(!should_fallback_to_local(
        404,
        r#"{"error":{"code":"not_found","message":"The requested model does not exist"}}"#
    ));
    assert!(!should_fallback_to_local(401, "unauthorized"));
    assert!(!should_fallback_to_local(
        400,
        r#"{"error":{"message":"invalid max_output_tokens"}}"#
    ));
    assert!(!should_fallback_to_local(500, "server error"));

    assert!(should_fallback_to_local(
        404,
        r#"{"error":{"type":"unsupported_endpoint"}}"#
    ));
    assert!(should_fallback_to_local(
        400,
        r#"{"error":{"type":"unsupported_file","param":"input_file"}}"#
    ));
}

#[test]
fn local_text_extraction_preserves_structure_and_decodes_rtf() {
    let markdown = extract_summary_text_from_bytes(b"# Title\n\n- one\n- two\n", "md")
        .expect("markdown extracts");
    assert!(markdown.contains("# Title\n\n- one\n- two"));

    let rtf =
        extract_summary_text_from_bytes(br"{\rtf1\ansi Meeting\par Decision\tab approved}", "rtf")
            .expect("rtf extracts");
    assert!(rtf.contains("Meeting\nDecision\tapproved"));
}
