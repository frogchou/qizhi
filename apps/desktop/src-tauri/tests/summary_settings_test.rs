use qizhi_desktop_lib::{
    contracts::{SummaryPromptTemplateInput, SummarySettingsInput},
    database::{AppError, Database},
};

#[test]
fn seeds_and_persists_summary_templates_and_model() {
    let database = Database::open(std::path::Path::new(":memory:")).expect("database opens");
    let repository = database.summary_settings();
    let defaults = repository.get().expect("defaults read");

    assert_eq!(defaults.model, "gpt-5.6-sol");
    assert_eq!(defaults.templates.len(), 5);
    assert_eq!(defaults.templates[0].title, "今日工作总结");
    assert!(defaults.templates[0].is_default);

    repository
        .save(&SummarySettingsInput {
            model: "gpt-5.6-pro".to_owned(),
            templates: vec![
                SummaryPromptTemplateInput {
                    id: None,
                    title: "管理层摘要".to_owned(),
                    prompt: "提炼结果、风险和下一步。".to_owned(),
                    sort_order: 0,
                    is_default: true,
                },
                SummaryPromptTemplateInput {
                    id: None,
                    title: "一句话".to_owned(),
                    prompt: "用一句话总结。".to_owned(),
                    sort_order: 1,
                    is_default: false,
                },
            ],
        })
        .expect("settings save");

    let saved = repository.get().expect("saved settings read");
    assert_eq!(saved.model, "gpt-5.6-pro");
    assert_eq!(saved.templates.len(), 2);
    assert_eq!(saved.templates[0].title, "管理层摘要");
    assert!(saved.templates[0].is_default);
}

#[test]
fn rejects_summary_settings_without_exactly_one_default_template() {
    let database = Database::open(std::path::Path::new(":memory:")).expect("database opens");
    let result = database.summary_settings().save(&SummarySettingsInput {
        model: "gpt-5.6".to_owned(),
        templates: vec![SummaryPromptTemplateInput {
            id: None,
            title: "摘要".to_owned(),
            prompt: "总结。".to_owned(),
            sort_order: 0,
            is_default: false,
        }],
    });

    assert!(matches!(result, Err(AppError::InvalidConfig)));
}

#[test]
fn rejects_duplicate_or_oversized_summary_templates() {
    let database = Database::open(std::path::Path::new(":memory:")).expect("database opens");
    let duplicate = database.summary_settings().save(&SummarySettingsInput {
        model: "gpt-5.6".to_owned(),
        templates: vec![
            SummaryPromptTemplateInput {
                id: None,
                title: "日报".to_owned(),
                prompt: "总结。".to_owned(),
                sort_order: 0,
                is_default: true,
            },
            SummaryPromptTemplateInput {
                id: None,
                title: " 日报 ".to_owned(),
                prompt: "再次总结。".to_owned(),
                sort_order: 1,
                is_default: false,
            },
        ],
    });
    assert!(matches!(duplicate, Err(AppError::InvalidConfig)));

    let oversized = database.summary_settings().save(&SummarySettingsInput {
        model: "gpt-5.6".to_owned(),
        templates: vec![SummaryPromptTemplateInput {
            id: None,
            title: "标题".repeat(31),
            prompt: "内容".repeat(2_001),
            sort_order: 0,
            is_default: true,
        }],
    });
    assert!(matches!(oversized, Err(AppError::InvalidConfig)));
}

#[test]
fn persists_more_than_twenty_summary_templates_without_truncation() {
    let database = Database::open(std::path::Path::new(":memory:")).expect("database opens");
    let templates = (0..25)
        .map(|index| SummaryPromptTemplateInput {
            id: None,
            title: format!("总结方式 {}", index + 1),
            prompt: format!("请使用第 {} 种方式总结。", index + 1),
            sort_order: index,
            is_default: index == 0,
        })
        .collect::<Vec<_>>();

    database
        .summary_settings()
        .save(&SummarySettingsInput {
            model: "gpt-5.6".to_owned(),
            templates,
        })
        .expect("unbounded templates save");

    let saved = database
        .summary_settings()
        .get()
        .expect("saved templates read");
    assert_eq!(saved.templates.len(), 25);
    assert_eq!(saved.templates[24].title, "总结方式 25");
    assert!(saved.templates[0].is_default);
}
