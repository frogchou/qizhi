use qizhi_desktop_lib::commands::knowledge::{
    KnowledgeQueryStreamEvent, RagflowAgentResultOutput, RagflowKnowledgeQueryOutput,
    unique_agent_ids,
};
use qizhi_desktop_lib::ragflow::client::{RagflowAgentReference, RagflowAgentSource};

#[test]
fn de_duplicates_agent_ids_without_changing_user_order() {
    assert_eq!(
        unique_agent_ids(vec![
            "agent-b".to_owned(),
            "agent-a".to_owned(),
            "agent-b".to_owned(),
            "  ".to_owned(),
        ]),
        vec!["agent-b".to_owned(), "agent-a".to_owned()]
    );
}

#[test]
fn serializes_partial_failures_and_authoritative_agent_state() {
    let output = RagflowKnowledgeQueryOutput {
        selection_token: "selection-1".to_owned(),
        chunks: vec![],
        retrieval_error: Some("检索暂不可用".to_owned()),
        agent_results: vec![RagflowAgentResultOutput {
            agent_id: "agent-a".to_owned(),
            answer: Some("部分回答".to_owned()),
            error: Some("回答中断".to_owned()),
            session_id: Some("session-a".to_owned()),
            session_invalid: false,
            steps: vec![],
            references: vec![],
            sources: vec![],
        }],
    };

    let json = serde_json::to_value(output).expect("output serializes");
    assert_eq!(json["retrievalError"], "检索暂不可用");
    assert_eq!(json["agentResults"][0]["answer"], "部分回答");
    assert_eq!(json["agentResults"][0]["sessionId"], "session-a");
}

#[test]
fn stream_events_use_a_stable_camel_case_tagged_contract() {
    let event = KnowledgeQueryStreamEvent::AgentFailed {
        agent_id: "agent-a".to_owned(),
        error: "session not found".to_owned(),
        session_invalid: true,
    };

    let json = serde_json::to_value(event).expect("event serializes");
    assert_eq!(json["kind"], "agentFailed");
    assert_eq!(json["agentId"], "agent-a");
    assert_eq!(json["sessionInvalid"], true);
}

#[test]
fn serializes_agent_references_for_streaming_and_the_authoritative_result() {
    let reference = RagflowAgentReference {
        citation_id: "315".to_owned(),
        chunk_id: "chunk-1".to_owned(),
        content: "知识片段".to_owned(),
        document_name: "人员名单.docx".to_owned(),
        document_id: "document-1".to_owned(),
        dataset_id: "dataset-1".to_owned(),
        similarity: 0.91,
        doc_type: "docx".to_owned(),
        positions: serde_json::json!([[1, 2, 3, 4, 5]]),
        document_metadata: serde_json::json!({"department": "研发部"}),
        url: String::new(),
    };
    let source = RagflowAgentSource {
        document_name: "人员名单.docx".to_owned(),
        document_id: "document-1".to_owned(),
        dataset_id: "dataset-1".to_owned(),
        citation_count: 1,
    };
    let event = KnowledgeQueryStreamEvent::AgentReferences {
        agent_id: "agent-a".to_owned(),
        references: vec![reference.clone()],
        sources: vec![source.clone()],
    };
    let event_json = serde_json::to_value(event).expect("event serializes");
    assert_eq!(event_json["kind"], "agentReferences");
    assert_eq!(event_json["references"][0]["citationId"], "315");

    let output = RagflowAgentResultOutput {
        agent_id: "agent-a".to_owned(),
        answer: Some("回答 [ID:315]".to_owned()),
        error: None,
        session_id: None,
        session_invalid: false,
        steps: vec![],
        references: vec![reference],
        sources: vec![source],
    };
    let output_json = serde_json::to_value(output).expect("result serializes");
    assert_eq!(output_json["references"][0]["documentId"], "document-1");
    assert_eq!(output_json["sources"][0]["citationCount"], 1);
}
