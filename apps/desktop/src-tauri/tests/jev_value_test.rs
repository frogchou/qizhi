use std::time::{SystemTime, UNIX_EPOCH};

use qizhi_desktop_lib::{
    contracts::{FileRecord, FileValueAssessmentInput, JevValuePolicyInput},
    database::Database,
    jev::{JevClient, extract_value_text},
};

#[test]
fn persists_a_user_configurable_jev_score_rubric_and_threshold() {
    let database = Database::open(std::path::Path::new(":memory:")).expect("database opens");
    let repository = database.jev_value_policy();
    let defaults = repository.get().expect("default policy reads");

    assert_eq!(defaults.criteria.len(), 5);
    assert_eq!(defaults.valuable_threshold, 2.5);

    repository
        .save(&JevValuePolicyInput {
            instructions: "判断文件是否值得长期复用。".to_owned(),
            criteria: vec![
                "无价值".to_owned(),
                "临时参考".to_owned(),
                "可复用".to_owned(),
            ],
            valuable_threshold: 1.5,
        })
        .expect("policy saves");
    let saved = repository.get().expect("saved policy reads");

    assert_eq!(saved.instructions, "判断文件是否值得长期复用。");
    assert_eq!(saved.criteria.len(), 3);
    assert_eq!(saved.valuable_threshold, 1.5);
}

#[test]
fn loads_current_value_results_for_many_files_in_one_repository_call() {
    let database = Database::open(std::path::Path::new(":memory:")).expect("database opens");
    let repository = database.value_assessments();
    let files = (1..=3)
        .map(|id| FileRecord {
            id,
            canonical_path: format!(r"D:\work\note-{id}.md"),
            file_identity: format!("ntfs:{id}"),
            modified_at_utc_ms: 100 + id,
            size_bytes: 12,
            source: "本机 NTFS 索引".to_owned(),
        })
        .collect::<Vec<_>>();
    for file in &files[..2] {
        repository
            .save(&FileValueAssessmentInput {
                canonical_path: file.canonical_path.clone(),
                file_identity: file.file_identity.clone(),
                modified_at_utc_ms: file.modified_at_utc_ms,
                status: "valuable".to_owned(),
                score: Some(3.0),
                confidence: Some(0.9),
                message: None,
            })
            .expect("assessment saves");
    }

    let loaded = repository
        .list_current_for_files(&files)
        .expect("batch assessment lookup");
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[&1].status, "valuable");
    assert!(!loaded.contains_key(&3));
}

fn temporary_path(name: &str, extension: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!("qizhi-{name}-{nonce}.{extension}"))
}

#[test]
fn parses_a_typesafe_score_into_a_value_judgment() {
    let body = r#"{
      "model":"jev-1.13",
      "answers":{
        "file_7":{
          "type":"score",
          "score":3.6,
          "confidence":0.91,
          "legend":{"0":"low","4":"high"},
          "probabilities":{"0":0.01,"4":0.84}
        }
      },
      "usage":{"input_tokens":120,"output_tokens":12}
    }"#;

    let answers = JevClient::parse_value_response(body).expect("valid TypeSafe response");

    assert_eq!(answers["file_7"].score, 3.6);
    assert_eq!(answers["file_7"].confidence, 0.91);
    assert!(answers["file_7"].is_valuable());
}

#[test]
fn persists_a_value_result_for_the_exact_file_version() {
    let database = Database::open(std::path::Path::new(":memory:")).expect("database opens");
    let repository = database.value_assessments();
    let input = FileValueAssessmentInput {
        canonical_path: r"D:\work\plan.md".to_owned(),
        file_identity: "ntfs:42".to_owned(),
        modified_at_utc_ms: 1_793_189_400_000,
        status: "valuable".to_owned(),
        score: Some(3.6),
        confidence: Some(0.91),
        message: None,
    };

    repository.save(&input).expect("assessment saves");
    let saved = repository
        .find_for_file(
            &input.canonical_path,
            &input.file_identity,
            input.modified_at_utc_ms,
        )
        .expect("assessment reads")
        .expect("assessment exists");

    assert_eq!(saved.status, "valuable");
    assert_eq!(saved.score, Some(3.6));
}

#[test]
fn extracts_bounded_utf8_text_for_value_analysis() {
    let path = temporary_path("jev-content", "md");
    std::fs::write(&path, "项目结论：采用本地优先的知识管理方案。").expect("fixture writes");

    let text = extract_value_text(&path).expect("text extracts");

    assert!(text.contains("本地优先"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn rejects_source_and_configuration_files_from_value_analysis() {
    for extension in ["json", "rs", "py"] {
        let path = temporary_path("jev-non-document", extension);
        std::fs::write(&path, "plain UTF-8 content").expect("fixture writes");

        let error = extract_value_text(&path).expect_err("non-document is rejected");

        assert_eq!(error, "JEV 仅分析文档与文本文件。");
        let _ = std::fs::remove_file(path);
    }
}
