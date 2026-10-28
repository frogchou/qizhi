use qizhi_desktop_lib::ragflow::client::RagflowClient;

#[test]
fn parses_accessible_chat_assistants_from_a_successful_response() {
    let chats = RagflowClient::parse_chat_list(
        r#"{"code":0,"message":"success","data":[{"id":"chat-a","name":"工作知识库","description":"工作资料问答"}]}"#,
    )
    .expect("chat list parses");

    assert_eq!(chats.len(), 1);
    assert_eq!(chats[0].id, "chat-a");
    assert_eq!(chats[0].name, "工作知识库");
}

#[test]
fn rejects_a_ragflow_business_error_even_when_the_response_is_json() {
    let error =
        RagflowClient::parse_chat_list(r#"{"code":102,"message":"API key is invalid","data":[]}"#)
            .expect_err("business failure must not become an empty chat list");

    assert_eq!(error, "RAGFlow：API key is invalid");
}

#[test]
fn rejects_a_success_response_without_an_answer() {
    let error = RagflowClient::parse_answer(r#"{"code":0,"message":"success","data":{}}"#)
        .expect_err("missing answer must not be shown as a successful reply");

    assert_eq!(error, "RAGFlow 未返回回答内容。".to_owned());
}
