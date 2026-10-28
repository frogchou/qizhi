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
fn parses_chat_assistants_from_the_current_ragflow_paged_response() {
    let chats = RagflowClient::parse_chat_list(
        r#"{"code":0,"message":"success","data":{"chats":[{"id":"chat-a","name":"工作知识库","description":"工作资料问答"}],"total":1}}"#,
    )
    .expect("paged chat list parses");

    assert_eq!(chats.len(), 1);
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

#[test]
fn parses_datasets_agents_retrieval_chunks_and_native_agent_answers() {
    let datasets = RagflowClient::parse_dataset_list(
        r#"{"code":0,"message":"success","data":[{"id":"kb-1","name":"项目资料","description":"项目文档"}]}"#,
    )
    .expect("datasets parse");
    assert_eq!(datasets[0].name, "项目资料");

    let agents = RagflowClient::parse_agent_list(
        r#"{"code":0,"message":"success","data":{"canvas":[{"id":"agent-1","type":"agent","title":"项目助手","description":"分析项目"},{"id":"group-1","type":"compilation_template_group","title":"模板"}]}}"#,
    )
    .expect("agents parse");
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].name, "项目助手");

    let chunks = RagflowClient::parse_retrieval(
        r#"{"code":0,"message":"success","data":{"chunks":[{"id":"chunk-1","content":"相关内容","document_keyword":"周报.docx","document_id":"document-1","dataset_id":"dataset-1","similarity":0.92}]}}"#,
    )
    .expect("retrieval parses");
    assert_eq!(chunks[0].document_name, "周报.docx");
    assert_eq!(chunks[0].document_id, "document-1");
    assert_eq!(chunks[0].dataset_id, "dataset-1");

    let answer = RagflowClient::parse_agent_answer(
        "agent-1",
        r#"{"code":0,"message":"success","data":{"data":{"content":"Agent 回答"},"session_id":"session-1"}}"#,
    )
    .expect("agent answer parses");
    assert_eq!(answer.answer, "Agent 回答");
    assert_eq!(answer.session_id, "session-1");
}

#[test]
fn parses_a_successful_dataset_list_when_ragflow_omits_message() {
    let datasets = RagflowClient::parse_dataset_list(
        r#"{"code":0,"data":[{"id":"kb-1","name":"项目资料","description":"项目文档"}],"total_datasets":1}"#,
    )
    .expect("RAGFlow dataset responses may omit the optional message field");

    assert_eq!(datasets.len(), 1);
    assert_eq!(datasets[0].id, "kb-1");
}

#[test]
fn parses_agents_when_the_agent_endpoint_omits_the_canvas_type() {
    let agents = RagflowClient::parse_agent_list(
        r#"{"code":0,"message":"success","data":{"canvas":[{"id":"agent-1","title":"项目助手","description":"分析项目"}],"total":1}}"#,
    )
    .expect("the agent listing endpoint already contains only agents");

    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].name, "项目助手");
}

#[test]
fn explains_when_an_agent_cannot_reach_its_own_model_service() {
    let error = RagflowClient::parse_agent_answer(
        "agent-1",
        r#"{"code":102,"message":"无法连接 Base URL，请检查网络、地址和代理设置。","data":{}}"#,
    )
    .expect_err("an Agent model connection failure must name the failing layer");

    assert_eq!(
        error,
        "所选 Agent 无法连接其配置的大模型服务，请在 RAGFlow 中检查该 Agent 的模型 Base URL、密钥和代理设置。"
    );
}
