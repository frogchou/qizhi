use rusqlite::{Connection, Result};

pub fn apply(connection: &Connection) -> Result<()> {
    connection.execute_batch(include_str!("../../migrations/0001_initial.sql"))?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version) VALUES (1)",
        [],
    )?;

    for (version, migration) in [
        (2, include_str!("../../migrations/0002_ntfs_index.sql")),
        (3, include_str!("../../migrations/0003_ntfs_staging.sql")),
        (
            4,
            include_str!("../../migrations/0004_ntfs_caller_policy.sql"),
        ),
        (
            5,
            include_str!("../../migrations/0005_ntfs_caller_policy_filters.sql"),
        ),
        (
            6,
            include_str!("../../migrations/0006_file_value_assessments.sql"),
        ),
        (
            7,
            include_str!("../../migrations/0007_jev_value_policy_and_indexer_restart.sql"),
        ),
        (8, include_str!("../../migrations/0008_summary_prompts.sql")),
        (9, include_str!("../../migrations/0009_summary_model.sql")),
        (
            10,
            include_str!("../../migrations/0010_ntfs_activity_history.sql"),
        ),
        (11, include_str!("../../migrations/0011_codex_projects.sql")),
        (12, include_str!("../../migrations/0012_codex_handoffs.sql")),
    ] {
        let applied = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
            [version],
            |row| row.get::<_, bool>(0),
        )?;
        if !applied {
            connection.execute_batch(migration)?;
            connection.execute(
                "INSERT INTO schema_migrations(version) VALUES (?1)",
                [version],
            )?;
        }
    }
    Ok(())
}
