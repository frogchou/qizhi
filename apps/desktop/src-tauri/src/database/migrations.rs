use rusqlite::{Connection, Result};

pub fn apply(connection: &Connection) -> Result<()> {
    connection.execute_batch(include_str!("../../migrations/0001_initial.sql"))?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version) VALUES (1)",
        [],
    )?;

    for (version, migration) in [(2, include_str!("../../migrations/0002_ntfs_index.sql"))] {
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
