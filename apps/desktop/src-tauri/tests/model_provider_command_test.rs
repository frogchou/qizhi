use qizhi_desktop_lib::commands::model_provider::{build_connection_test_body, model_api_url};

#[test]
fn appends_chat_completions_to_the_configured_api_root() {
    assert_eq!(
        model_api_url("https://example.test/v1/", "chat/completions").unwrap(),
        "https://example.test/v1/chat/completions"
    );
    assert_eq!(
        model_api_url(
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "chat/completions"
        )
        .unwrap(),
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
}

#[test]
fn builds_a_minimal_non_streaming_chat_completion_request() {
    let body = build_connection_test_body("qwen-plus").unwrap();
    let value: serde_json::Value = serde_json::from_str(&body).unwrap();

    assert_eq!(value["model"], "qwen-plus");
    assert_eq!(value["stream"], false);
    assert_eq!(value["max_tokens"], 1);
    assert_eq!(value["messages"][0]["role"], "user");
}

#[test]
fn rejects_invalid_provider_test_urls_and_models() {
    assert!(model_api_url("file:///tmp/models", "chat/completions").is_err());
    assert!(build_connection_test_body("   ").is_err());
}
