use crate::database::Database;

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
}
