use crate::{
    contracts::{JevValuePolicy, JevValuePolicyInput},
    database::{AppError, Database},
};

#[derive(Clone)]
pub struct JevValuePolicyRepository {
    database: Database,
}

impl JevValuePolicyRepository {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn get(&self) -> Result<JevValuePolicy, AppError> {
        self.database.with_connection(|connection| {
            connection.query_row(
                "SELECT instructions,criteria_json,valuable_threshold FROM jev_value_policy WHERE id=1",
                [],
                |row| {
                    let criteria_json: String = row.get(1)?;
                    let criteria = serde_json::from_str(&criteria_json).map_err(|_| {
                        rusqlite::Error::InvalidColumnType(
                            1,
                            "criteria_json".to_owned(),
                            rusqlite::types::Type::Text,
                        )
                    })?;
                    Ok(JevValuePolicy {
                        instructions: row.get(0)?,
                        criteria,
                        valuable_threshold: row.get(2)?,
                    })
                },
            )
        })
    }

    pub fn save(&self, policy: &JevValuePolicyInput) -> Result<(), AppError> {
        validate(policy)?;
        let criteria_json =
            serde_json::to_string(&policy.criteria).map_err(|_| AppError::InvalidConfig)?;
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "UPDATE jev_value_policy SET instructions=?1,criteria_json=?2,valuable_threshold=?3 WHERE id=1",
                (&policy.instructions, criteria_json, policy.valuable_threshold),
            )?;
            // A changed rubric changes the meaning of every prior score.
            transaction.execute("DELETE FROM file_value_assessments", [])?;
            Ok(())
        })
    }
}

fn validate(policy: &JevValuePolicyInput) -> Result<(), AppError> {
    let instructions = policy.instructions.trim();
    if instructions.is_empty() || instructions.chars().count() > 2_000 {
        return Err(AppError::InvalidConfig);
    }
    if !(2..=10).contains(&policy.criteria.len())
        || policy
            .criteria
            .iter()
            .any(|level| level.trim().is_empty() || level.chars().count() > 500)
        || !policy.valuable_threshold.is_finite()
        || policy.valuable_threshold < 0.0
        || policy.valuable_threshold > (policy.criteria.len() - 1) as f64
    {
        return Err(AppError::InvalidConfig);
    }
    Ok(())
}
