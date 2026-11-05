use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use uuid::Uuid;

const SELECTION_TTL: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Clone, Default)]
pub struct KnowledgeSelectionStore(Arc<Mutex<HashMap<String, StoredSelection>>>);

struct StoredSelection {
    created_at: Instant,
    documents: HashSet<(String, String)>,
}

impl KnowledgeSelectionStore {
    pub fn register(&self, documents: impl IntoIterator<Item = (String, String)>) -> String {
        let token = Uuid::new_v4().to_string();
        if let Ok(mut values) = self.0.lock() {
            values.retain(|_, value| value.created_at.elapsed() <= SELECTION_TTL);
            values.insert(
                token.clone(),
                StoredSelection {
                    created_at: Instant::now(),
                    documents: documents.into_iter().collect(),
                },
            );
        }
        token
    }

    pub fn allows_documents<'a>(
        &self,
        token: &str,
        documents: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> bool {
        let Ok(mut values) = self.0.lock() else {
            return false;
        };
        values.retain(|_, value| value.created_at.elapsed() <= SELECTION_TTL);
        let Some(selection) = values.get(token) else {
            return false;
        };
        documents.into_iter().all(|(dataset_id, document_id)| {
            selection
                .documents
                .contains(&(dataset_id.to_owned(), document_id.to_owned()))
        })
    }
}
