use crate::contracts::CodexRagflowChunkInput;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

const SELECTION_TTL: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Clone, Default)]
pub struct KnowledgeSelectionStore(Arc<Mutex<HashMap<String, StoredSelection>>>);

struct StoredSelection {
    created_at: Instant,
    endpoint: String,
    question: String,
    documents: HashMap<(String, String), String>,
    chunks: HashMap<(String, String, String), CodexRagflowChunkInput>,
}

impl KnowledgeSelectionStore {
    pub fn register(&self, documents: impl IntoIterator<Item = (String, String)>) -> String {
        self.register_query(
            String::new(),
            String::new(),
            Vec::new(),
            documents
                .into_iter()
                .map(|(ds, doc)| (ds, doc, String::new())),
        )
    }

    pub(crate) fn register_query(
        &self,
        endpoint: String,
        question: String,
        chunks: Vec<CodexRagflowChunkInput>,
        documents: impl IntoIterator<Item = (String, String, String)>,
    ) -> String {
        let token = Uuid::new_v4().to_string();
        let mut docs = HashMap::new();
        let mut evidence = HashMap::new();
        for (ds, doc, name) in documents {
            docs.insert((ds, doc), name);
        }
        for chunk in chunks {
            docs.entry((chunk.dataset_id.clone(), chunk.document_id.clone()))
                .or_insert_with(|| chunk.document_name.clone());
            evidence
                .entry((
                    chunk.dataset_id.clone(),
                    chunk.document_id.clone(),
                    chunk.chunk_id.clone(),
                ))
                .or_insert(chunk);
        }
        if let Ok(mut all) = self.0.lock() {
            all.retain(|_, value| value.created_at.elapsed() <= SELECTION_TTL);
            all.insert(
                token.clone(),
                StoredSelection {
                    created_at: Instant::now(),
                    endpoint,
                    question,
                    documents: docs,
                    chunks: evidence,
                },
            );
        }
        token
    }

    fn read<T>(&self, token: &str, get: impl FnOnce(&StoredSelection) -> Option<T>) -> Option<T> {
        let mut all = self.0.lock().ok()?;
        all.retain(|_, v| v.created_at.elapsed() <= SELECTION_TTL);
        get(all.get(token)?)
    }

    pub fn allows_documents<'a>(
        &self,
        token: &str,
        docs: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> bool {
        self.read(token, |s| {
            Some(
                docs.into_iter()
                    .all(|(ds, doc)| s.documents.contains_key(&(ds.to_owned(), doc.to_owned()))),
            )
        })
        .unwrap_or(false)
    }

    pub(crate) fn chunk(
        &self,
        token: &str,
        dataset: &str,
        doc: &str,
        chunk: &str,
    ) -> Option<(String, String, CodexRagflowChunkInput)> {
        self.read(token, |s| {
            s.chunks
                .get(&(dataset.to_owned(), doc.to_owned(), chunk.to_owned()))
                .map(|v| (s.endpoint.clone(), s.question.clone(), v.clone()))
        })
    }

    pub(crate) fn document(
        &self,
        token: &str,
        dataset: &str,
        doc: &str,
    ) -> Option<(String, String)> {
        self.read(token, |s| {
            s.documents
                .get(&(dataset.to_owned(), doc.to_owned()))
                .map(|name| (s.endpoint.clone(), name.to_owned()))
        })
    }
}
