use qizhi_desktop_lib::ragflow::client::{RagflowAgentStreamEvent, RagflowClient};

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

#[test]
fn gives_agent_workflows_a_longer_response_window_than_simple_api_calls() {
    assert_eq!(RagflowClient::agent_request_timeout().as_secs(), 120);
}

#[test]
fn parses_uploaded_document_ids_before_requesting_dataset_parsing() {
    let upload = RagflowClient::parse_upload_response(
        r#"{"code":0,"data":[{"id":"document-1","name":"周报.docx","run":"UNSTART"}]}"#,
    )
    .expect("successful upload response parses");

    assert_eq!(upload.document_ids, vec!["document-1"]);
    assert_eq!(upload.document_count, 1);
}

#[test]
fn rejects_an_upload_response_without_document_ids_when_parsing_is_requested() {
    let error = RagflowClient::parse_upload_response(r#"{"code":0,"data":[]}"#)
        .expect_err("an empty upload response cannot be parsed later");

    assert_eq!(error, "RAGFlow 上传未返回可解析的文档。".to_owned());
}

#[test]
fn accepts_a_successful_parse_action_without_a_data_payload() {
    RagflowClient::parse_parse_action_response(r#"{"code":0}"#)
        .expect("the documented parse endpoint may return code only");
}

#[test]
fn preserves_successful_upload_when_starting_parsing_fails() {
    let upload = RagflowClient::parse_upload_response(
        r#"{"code":0,"data":[{"id":"document-1","name":"周报.docx"}]}"#,
    )
    .expect("upload parses")
    .with_parsing_outcome(Err("该知识库使用采集管线。".to_owned()));

    assert!(!upload.parsing_started);
    assert_eq!(
        upload.parsing_error,
        Some("该知识库使用采集管线。".to_owned())
    );
    assert_eq!(upload.document_count, 1);
}

#[test]
fn decodes_native_agent_sse_without_leaking_thinking_text() {
    let body = concat!(
        ": heartbeat\n\n",
        "event: message\n",
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"session_id\":\"session-1\",\"data\":{\"content\":\"<think>private reasoning\"}}\n\n",
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":\n",
        "data: {\"content\":\"</think>最终\"}}\n\n",
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"答案\"}}\n\n",
        "data: [DONE]\n\n",
    );

    let (answer, events) =
        RagflowClient::decode_agent_stream("agent-1", body).expect("native stream decodes");

    assert_eq!(answer.answer, "最终答案");
    assert_eq!(answer.session_id, "session-1");
    assert!(!format!("{events:?}").contains("private reasoning"));
    assert!(events.contains(&RagflowAgentStreamEvent::Thinking { active: true }));
    assert!(events.contains(&RagflowAgentStreamEvent::Thinking { active: false }));
}

#[test]
fn honors_thinking_boundaries_nested_inside_real_ragflow_message_data() {
    let body = concat!(
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"session_id\":\"session-1\",\"data\":{\"content\":\"\",\"start_to_think\":true}}\n\n",
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"内部规划，不应显示\"}}\n\n",
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"\",\"end_to_think\":true}}\n\n",
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"最终答案\"}}\n\n",
        "data: {\"event\":\"message_end\",\"message_id\":\"m1\",\"session_id\":\"session-1\",\"data\":{\"reference\":{}}}\n\n",
    );

    let (answer, events) =
        RagflowClient::decode_agent_stream("agent-1", body).expect("real stream decodes");

    assert_eq!(answer.answer, "最终答案");
    assert!(!format!("{events:?}").contains("内部规划"));
    assert!(events.contains(&RagflowAgentStreamEvent::Thinking { active: true }));
    assert!(events.contains(&RagflowAgentStreamEvent::Thinking { active: false }));
}

#[test]
fn preserves_object_keyed_agent_citations_and_source_documents_from_message_end() {
    let body = concat!(
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"session_id\":\"session-1\",\"data\":{\"content\":\"最终答案 [ID:315]\"}}\n\n",
        "data: {\"event\":\"message_end\",\"message_id\":\"m1\",\"session_id\":\"session-1\",\"data\":{\"reference\":{\"chunks\":{\"315\":{\"id\":\"chunk-uuid\",\"content\":\"支持答案的知识片段\",\"dataset_id\":\"dataset-1\",\"document_id\":\"document-1\",\"document_name\":\"人员名单.docx\",\"doc_type\":\"docx\",\"similarity\":0.91,\"positions\":[[1,2,3,4,5]],\"document_metadata\":{\"department\":\"研发部\"}}},\"doc_aggs\":{\"人员名单.docx\":{\"count\":1,\"doc_id\":\"document-1\",\"doc_name\":\"人员名单.docx\"}}}}}\n\n",
    );

    let (answer, events) =
        RagflowClient::decode_agent_stream("agent-1", body).expect("reference stream decodes");

    assert_eq!(answer.references.len(), 1);
    let citation = &answer.references[0];
    assert_eq!(citation.citation_id, "315");
    assert_eq!(citation.chunk_id, "chunk-uuid");
    assert_eq!(citation.content, "支持答案的知识片段");
    assert_eq!(citation.document_name, "人员名单.docx");
    assert_eq!(citation.document_id, "document-1");
    assert_eq!(citation.dataset_id, "dataset-1");
    assert_eq!(answer.sources.len(), 1);
    assert_eq!(answer.sources[0].citation_count, 1);
    assert!(events.iter().any(|event| matches!(
        event,
        RagflowAgentStreamEvent::References { references, sources }
            if references.len() == 1 && sources.len() == 1
    )));
}

#[test]
fn replaces_an_intermediate_message_and_sanitizes_finished_steps() {
    let body = concat!(
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"中间输出\"}}\n\n",
        "data: {\"event\":\"node_finished\",\"data\":{\"name\":\"检索节点\",\"type\":\"retrieval\",\"status\":\"success\",\"elapsed_time\":1.25,\"error\":\"token=secret-value\",\"inputs\":{\"api_key\":\"must-not-leak\"}}}\n\n",
        "data: {\"event\":\"message\",\"message_id\":\"m2\",\"data\":{\"content\":\"最终输出\"}}\n\n",
        "data: [DONE]\n\n",
    );

    let (answer, events) =
        RagflowClient::decode_agent_stream("agent-1", body).expect("stream decodes");

    assert_eq!(answer.answer, "最终输出");
    assert!(events.iter().any(|event| matches!(
        event,
        RagflowAgentStreamEvent::AnswerReset { message_id } if message_id == "m2"
    )));
    let debug = format!("{events:?}");
    assert!(debug.contains("检索节点"));
    assert!(!debug.contains("must-not-leak"));
    assert!(!debug.contains("secret-value"));
}

#[test]
fn accepts_legacy_component_events_and_non_stream_json_fallback() {
    let legacy_stream = concat!(
        "data: {\"event\":\"component_finished\",\"data\":{\"title\":\"旧节点\",\"component_type\":\"retrieval\",\"status\":\"completed\"}}\n\n",
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"兼容回答\"}}\n\n",
        "data: [DONE]\n\n",
    );
    let (_, events) = RagflowClient::decode_agent_stream("agent-1", legacy_stream)
        .expect("legacy component event decodes");
    assert!(events.iter().any(|event| matches!(
        event,
        RagflowAgentStreamEvent::Step(step) if step.title == "旧节点"
    )));

    let (answer, events) = RagflowClient::decode_agent_stream(
        "agent-1",
        r#"{"code":0,"data":{"data":{"content":"旧版回答"},"session_id":"legacy-session"}}"#,
    )
    .expect("single JSON fallback decodes");
    assert_eq!(answer.answer, "旧版回答");
    assert_eq!(answer.session_id, "legacy-session");
    assert_eq!(
        events,
        vec![RagflowAgentStreamEvent::Delta {
            delta: "旧版回答".to_owned()
        }]
    );
}

#[test]
fn rejects_stream_business_errors_and_unclosed_thinking() {
    let error = RagflowClient::decode_agent_stream(
        "agent-1",
        "data: {\"code\":102,\"message\":\"agent failed\"}\n\n",
    )
    .expect_err("business errors must fail");
    assert_eq!(error, "RAGFlow：agent failed");

    let error = RagflowClient::decode_agent_stream(
        "agent-1",
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"<think>private forever\"}}\n\ndata: [DONE]\n\n",
    )
    .expect_err("unfinished thinking must never be treated as an answer");
    assert_eq!(error, "RAGFlow Agent 未返回可安全展示的回答内容。");
}

#[test]
fn never_leaks_thinking_when_markers_are_split_at_any_byte_boundary() {
    let content = "<think>private reasoning</think>answer";
    for split in 1..content.len() {
        let first = &content[..split];
        let second = &content[split..];
        let body = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            serde_json::json!({
                "event": "message",
                "message_id": "m1",
                "data": { "content": first }
            }),
            serde_json::json!({
                "event": "message",
                "message_id": "m1",
                "data": { "content": second }
            })
        );

        let (answer, events) = RagflowClient::decode_agent_stream("agent-1", &body)
            .unwrap_or_else(|error| panic!("split {split} failed: {error}"));
        assert_eq!(answer.answer, "answer", "split {split}");
        assert!(!format!("{events:?}").contains("private"), "split {split}");
    }
}

#[test]
fn resets_thinking_state_when_a_new_message_replaces_an_intermediate_message() {
    let body = concat!(
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"<think>private\"}}\n\n",
        "data: {\"event\":\"message\",\"message_id\":\"m2\",\"data\":{\"content\":\"final answer\"}}\n\n",
        "data: [DONE]\n\n",
    );

    let (answer, events) =
        RagflowClient::decode_agent_stream("agent-1", body).expect("replacement decodes");
    assert_eq!(answer.answer, "final answer");
    assert!(!format!("{events:?}").contains("private"));
}

#[test]
fn requires_a_terminal_marker_but_accepts_message_end() {
    let interrupted = "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"partial\"}}\n\n";
    let error = RagflowClient::decode_agent_stream("agent-1", interrupted)
        .expect_err("EOF without a terminal event must fail");
    assert!(error.contains("中断"));

    let complete = concat!(
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"complete\"}}\n\n",
        "data: {\"event\":\"message_end\",\"session_id\":\"session-1\"}\n\n",
    );
    let (answer, _) =
        RagflowClient::decode_agent_stream("agent-1", complete).expect("message_end completes");
    assert_eq!(answer.answer, "complete");
    assert_eq!(answer.session_id, "session-1");
}

#[test]
fn redacts_sensitive_server_controlled_trace_fields() {
    let body = concat!(
        "data: {\"event\":\"node_finished\",\"data\":{\"title\":\"Authorization: Bearer top-secret\",\"type\":\"api_key=secret\",\"status\":\"password=hunter2\",\"error\":\"token=secret-value\"}}\n\n",
        "data: {\"event\":\"message\",\"message_id\":\"m1\",\"data\":{\"content\":\"answer\"}}\n\n",
        "data: [DONE]\n\n",
    );
    let (_, events) = RagflowClient::decode_agent_stream("agent-1", body).expect("stream decodes");
    let debug = format!("{events:?}");
    for secret in ["top-secret", "hunter2", "secret-value"] {
        assert!(!debug.contains(secret));
    }
}
