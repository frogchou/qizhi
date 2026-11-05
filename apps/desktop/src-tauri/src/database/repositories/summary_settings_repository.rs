use crate::{
    contracts::{
        SummaryPromptTemplate, SummaryPromptTemplateInput, SummarySettings, SummarySettingsInput,
    },
    database::{AppError, Database},
};

#[derive(Clone)]
pub struct SummarySettingsRepository {
    database: Database,
}

impl SummarySettingsRepository {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn get(&self) -> Result<SummarySettings, AppError> {
        self.database.with_connection(|connection| {
            let model = connection.query_row(
                "SELECT model FROM openai_summary_settings WHERE id=1",
                [],
                |row| row.get(0),
            )?;
            let mut statement = connection.prepare(
                "SELECT id,title,prompt,sort_order,is_default FROM summary_prompt_templates ORDER BY sort_order,id",
            )?;
            let templates = statement
                .query_map([], |row| {
                    Ok(SummaryPromptTemplate {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        prompt: row.get(2)?,
                        sort_order: row.get(3)?,
                        is_default: row.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(SummarySettings { model, templates })
        })
    }

    pub fn save(&self, input: &SummarySettingsInput) -> Result<(), AppError> {
        validate(input)?;
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "UPDATE openai_summary_settings SET model=?1 WHERE id=1",
                [&input.model.trim()],
            )?;
            transaction.execute("DELETE FROM summary_prompt_templates", [])?;
            for template in &input.templates {
                transaction.execute(
                    "INSERT INTO summary_prompt_templates(title,prompt,sort_order,is_default) VALUES (?1,?2,?3,?4)",
                    (&template.title.trim(), &template.prompt.trim(), template.sort_order, template.is_default),
                )?;
            }
            Ok(())
        })
    }
}

fn validate(input: &SummarySettingsInput) -> Result<(), AppError> {
    let normalized_titles = input
        .templates
        .iter()
        .map(|template| template.title.trim().to_lowercase())
        .collect::<std::collections::HashSet<_>>();
    let sort_orders = input
        .templates
        .iter()
        .map(|template| template.sort_order)
        .collect::<std::collections::HashSet<_>>();
    if input.model.trim().is_empty()
        || input.model.chars().count() > 120
        || input.templates.is_empty()
        || input
            .templates
            .iter()
            .filter(|item| item.is_default)
            .count()
            != 1
        || input.templates.iter().any(invalid_template)
        || normalized_titles.len() != input.templates.len()
        || sort_orders.len() != input.templates.len()
    {
        return Err(AppError::InvalidConfig);
    }
    Ok(())
}

fn invalid_template(template: &SummaryPromptTemplateInput) -> bool {
    template.title.trim().is_empty()
        || template.title.chars().count() > 60
        || template.prompt.trim().is_empty()
        || template.prompt.chars().count() > 4_000
        || template.sort_order < 0
}
