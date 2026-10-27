use rusqlite::{Connection, Result};

pub fn apply(connection: &Connection) -> Result<()> {
    connection.execute_batch(include_str!("../../migrations/0001_initial.sql"))?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version) VALUES (1)",
        [],
    )?;
    Ok(())
}
