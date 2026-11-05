use std::{
    cmp::Ordering,
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    fmt,
    hash::{DefaultHasher, Hash, Hasher},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering as AtomicOrdering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{
    contracts::FileRecord,
    scan::file_filter::{FileCategory, FileTypeFilter},
};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceCategory {
    All,
    Documents,
    SourceCode,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceSort {
    NameAsc,
    NameDesc,
    TimeAsc,
    TimeDesc,
    TypeAsc,
    TypeDesc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceEntryKind {
    Directory,
    File,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceValueSummary {
    pub valuable: usize,
    pub not_valuable: usize,
    pub pending: usize,
    pub failed: usize,
    pub unsupported: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub id: String,
    pub kind: WorkspaceEntryKind,
    pub name: String,
    pub canonical_path: String,
    pub file_id: Option<i64>,
    pub modified_at_utc_ms: i64,
    pub size_bytes: i64,
    pub source: String,
    pub file_count: usize,
    pub child_directory_count: usize,
    pub has_children: bool,
    pub value_summary: WorkspaceValueSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePage {
    pub query_id: String,
    pub entries: Vec<WorkspaceEntry>,
    pub total_file_count: usize,
    pub next_cursor: Option<usize>,
}

pub struct WorkspaceBuildInput {
    pub files: Vec<FileRecord>,
    pub allowed_roots: Vec<String>,
    pub threshold: u16,
    pub category: WorkspaceCategory,
    pub search: String,
    pub value_statuses: HashMap<i64, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceBuildError {
    InvalidThreshold,
    NoAllowedRoots,
}

impl fmt::Display for WorkspaceBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidThreshold => formatter.write_str("invalid directory grouping threshold"),
            Self::NoAllowedRoots => formatter.write_str("no allowed roots"),
        }
    }
}

#[derive(Clone, Debug)]
struct WorkspaceFile {
    record: FileRecord,
    normalized_path: String,
}

#[derive(Clone, Debug)]
struct DirectoryNode {
    id: String,
    display_path: String,
    normalized_path: String,
    parent: Option<String>,
    children: BTreeSet<String>,
    direct_base_files: Vec<i64>,
    direct_visible_files: Vec<i64>,
    base_subtree_files: Vec<i64>,
    visible_subtree_files: Vec<i64>,
    qualified: bool,
    has_qualified_descendant_or_self: bool,
}

impl DirectoryNode {
    fn new(display_path: String, normalized_path: String, parent: Option<String>) -> Self {
        Self {
            id: directory_id(&normalized_path),
            display_path,
            normalized_path,
            parent,
            children: BTreeSet::new(),
            direct_base_files: Vec::new(),
            direct_visible_files: Vec::new(),
            base_subtree_files: Vec::new(),
            visible_subtree_files: Vec::new(),
            qualified: false,
            has_qualified_descendant_or_self: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct WorkspaceTree {
    directories: HashMap<String, DirectoryNode>,
    directory_ids: HashMap<String, String>,
    files: HashMap<i64, WorkspaceFile>,
    visible_file_ids: BTreeSet<i64>,
    root_keys: HashSet<String>,
    top_contexts: BTreeSet<String>,
    value_statuses: HashMap<i64, String>,
}

impl WorkspaceTree {
    pub fn build(input: WorkspaceBuildInput) -> Result<Self, WorkspaceBuildError> {
        if !(2..=100).contains(&input.threshold) {
            return Err(WorkspaceBuildError::InvalidThreshold);
        }
        let roots = input
            .allowed_roots
            .into_iter()
            .map(|root| {
                let display = visible_windows_path(&root);
                (normalize_windows_path(&display), display)
            })
            .filter(|(normalized, _)| !normalized.is_empty())
            .collect::<Vec<_>>();
        if roots.is_empty() {
            return Err(WorkspaceBuildError::NoAllowedRoots);
        }

        let filter = match input.category {
            WorkspaceCategory::All => {
                FileTypeFilter::new(vec![FileCategory::Documents, FileCategory::SourceCode])
            }
            WorkspaceCategory::Documents => FileTypeFilter::new(vec![FileCategory::Documents]),
            WorkspaceCategory::SourceCode => FileTypeFilter::new(vec![FileCategory::SourceCode]),
        };
        let mut deduplicated = HashMap::<String, FileRecord>::new();
        for mut record in input.files {
            record.canonical_path = visible_windows_path(&record.canonical_path);
            if !filter.allows(Path::new(&record.canonical_path)) {
                continue;
            }
            let key = normalize_windows_path(&record.canonical_path);
            match deduplicated.get(&key) {
                Some(existing) if existing.modified_at_utc_ms >= record.modified_at_utc_ms => {}
                _ => {
                    deduplicated.insert(key, record);
                }
            }
        }

        let mut directories = HashMap::<String, DirectoryNode>::new();
        let mut files = HashMap::<i64, WorkspaceFile>::new();
        let mut visible_file_ids = BTreeSet::new();
        let root_keys = roots
            .iter()
            .map(|(normalized, display)| {
                directories.insert(
                    normalized.clone(),
                    DirectoryNode::new(display.clone(), normalized.clone(), None),
                );
                normalized.clone()
            })
            .collect::<HashSet<_>>();

        for record in deduplicated.into_values() {
            let normalized_path = normalize_windows_path(&record.canonical_path);
            let Some((root_key, _)) = roots
                .iter()
                .filter(|(root, _)| is_same_or_descendant(&normalized_path, root))
                .max_by_key(|(root, _)| root.len())
            else {
                continue;
            };
            let Some(parent_display) = Path::new(&record.canonical_path)
                .parent()
                .map(|path| path.to_string_lossy().to_string())
            else {
                continue;
            };
            let normalized_parent = normalize_windows_path(&parent_display);
            ensure_directory_chain(
                &mut directories,
                &parent_display,
                &normalized_parent,
                root_key,
            );
            let matches_search = input.search.trim().is_empty()
                || wildcard_matches(
                    Path::new(&record.canonical_path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(&record.canonical_path),
                    input.search.trim(),
                );
            if let Some(parent) = directories.get_mut(&normalized_parent) {
                parent.direct_base_files.push(record.id);
                if matches_search {
                    parent.direct_visible_files.push(record.id);
                    visible_file_ids.insert(record.id);
                }
            }
            files.insert(
                record.id,
                WorkspaceFile {
                    record,
                    normalized_path,
                },
            );
        }

        let mut tree = Self {
            directories,
            directory_ids: HashMap::new(),
            files,
            visible_file_ids,
            root_keys,
            top_contexts: BTreeSet::new(),
            value_statuses: input.value_statuses,
        };
        let roots_to_compute = tree.root_keys.iter().cloned().collect::<Vec<_>>();
        for root in &roots_to_compute {
            tree.compute_statistics(root, usize::from(input.threshold));
        }
        tree.directory_ids = tree
            .directories
            .iter()
            .map(|(path, node)| (node.id.clone(), path.clone()))
            .collect();
        tree.top_contexts = tree.find_top_contexts();
        Ok(tree)
    }

    pub fn page(
        &self,
        parent_id: Option<&str>,
        cursor: usize,
        limit: usize,
        sort: WorkspaceSort,
    ) -> WorkspacePage {
        let mut entries = match parent_id {
            Some(id) => self
                .directory_ids
                .get(id)
                .map(|path| self.entries_for_directory(path))
                .unwrap_or_default(),
            None => self.root_entries(),
        };
        sort_entries(&mut entries, sort);
        let total = entries.len();
        let limit = limit.clamp(1, 200);
        let entries = entries.into_iter().skip(cursor).take(limit).collect();
        let next = cursor.saturating_add(limit);
        WorkspacePage {
            query_id: String::new(),
            entries,
            total_file_count: self.visible_file_ids.len(),
            next_cursor: (next < total).then_some(next),
        }
    }

    pub fn resolve(&self, file_ids: &[i64], directory_ids: &[String]) -> Vec<i64> {
        let mut resolved = BTreeSet::new();
        for id in file_ids {
            if self.visible_file_ids.contains(id) {
                resolved.insert(*id);
            }
        }
        for id in directory_ids {
            let Some(path) = self.directory_ids.get(id) else {
                continue;
            };
            if let Some(node) = self.directories.get(path) {
                resolved.extend(node.visible_subtree_files.iter().copied());
            }
        }
        resolved.into_iter().collect()
    }

    pub fn directory_path(&self, id: &str) -> Option<&str> {
        self.directory_ids
            .get(id)
            .and_then(|path| self.directories.get(path))
            .map(|node| node.display_path.as_str())
    }

    pub fn visible_file_ids(&self) -> Vec<i64> {
        self.visible_file_ids.iter().copied().collect()
    }

    pub fn set_value_statuses(&mut self, value_statuses: HashMap<i64, String>) {
        self.value_statuses = value_statuses;
    }

    fn compute_statistics(&mut self, path: &str, threshold: usize) -> (Vec<i64>, Vec<i64>, bool) {
        let children = self
            .directories
            .get(path)
            .map(|node| node.children.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut base = self
            .directories
            .get(path)
            .map(|node| node.direct_base_files.clone())
            .unwrap_or_default();
        let mut visible = self
            .directories
            .get(path)
            .map(|node| node.direct_visible_files.clone())
            .unwrap_or_default();
        let mut descendant_qualified = false;
        let mut changed_child_count = 0_usize;
        for child in children {
            let (child_base, child_visible, child_qualified) =
                self.compute_statistics(&child, threshold);
            if !child_base.is_empty() {
                changed_child_count += 1;
            }
            base.extend(child_base);
            visible.extend(child_visible);
            descendant_qualified |= child_qualified;
        }
        base.sort_unstable();
        base.dedup();
        visible.sort_unstable();
        visible.dedup();
        let is_root = self.root_keys.contains(path);
        let direct_count = self
            .directories
            .get(path)
            .map(|node| node.direct_base_files.len())
            .unwrap_or_default();
        let qualified = !is_root && (direct_count >= threshold || changed_child_count >= threshold);
        let has_qualified = qualified || descendant_qualified;
        if let Some(node) = self.directories.get_mut(path) {
            node.base_subtree_files = base.clone();
            node.visible_subtree_files = visible.clone();
            node.qualified = qualified;
            node.has_qualified_descendant_or_self = has_qualified;
        }
        (base, visible, has_qualified)
    }

    fn find_top_contexts(&self) -> BTreeSet<String> {
        let deepest = self
            .directories
            .values()
            .filter(|node| {
                node.qualified
                    && !node.children.iter().any(|child| {
                        self.directories
                            .get(child)
                            .is_some_and(|value| value.has_qualified_descendant_or_self)
                    })
                    && !node.visible_subtree_files.is_empty()
            })
            .map(|node| {
                node.parent
                    .as_ref()
                    .filter(|parent| !self.root_keys.contains(*parent))
                    .cloned()
                    .unwrap_or_else(|| node.normalized_path.clone())
            })
            .collect::<BTreeSet<_>>();

        deepest
            .iter()
            .filter(|candidate| {
                !deepest
                    .iter()
                    .any(|other| other != *candidate && is_same_or_descendant(candidate, other))
            })
            .cloned()
            .collect()
    }

    fn root_entries(&self) -> Vec<WorkspaceEntry> {
        let mut entries = self
            .top_contexts
            .iter()
            .filter_map(|path| self.directory_entry(path))
            .collect::<Vec<_>>();
        let covered = self.top_contexts.iter().collect::<Vec<_>>();
        entries.extend(self.visible_file_ids.iter().filter_map(|id| {
            let file = self.files.get(id)?;
            (!covered
                .iter()
                .any(|directory| is_same_or_descendant(&file.normalized_path, directory)))
            .then(|| self.file_entry(file))
        }));
        entries
    }

    fn entries_for_directory(&self, path: &str) -> Vec<WorkspaceEntry> {
        let Some(parent) = self.directories.get(path) else {
            return vec![];
        };
        let shown_children = parent
            .children
            .iter()
            .filter(|child| {
                self.directories
                    .get(*child)
                    .is_some_and(|node| !node.visible_subtree_files.is_empty())
            })
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut entries = shown_children
            .iter()
            .filter_map(|child| self.directory_entry(child))
            .collect::<Vec<_>>();
        entries.extend(parent.visible_subtree_files.iter().filter_map(|id| {
            let file = self.files.get(id)?;
            (!shown_children
                .iter()
                .any(|child| is_same_or_descendant(&file.normalized_path, child)))
            .then(|| self.file_entry(file))
        }));
        entries
    }

    fn directory_entry(&self, path: &str) -> Option<WorkspaceEntry> {
        let node = self.directories.get(path)?;
        let modified = node
            .visible_subtree_files
            .iter()
            .filter_map(|id| self.files.get(id))
            .map(|file| file.record.modified_at_utc_ms)
            .max()
            .unwrap_or_default();
        let size_bytes = node
            .visible_subtree_files
            .iter()
            .filter_map(|id| self.files.get(id))
            .map(|file| file.record.size_bytes)
            .sum();
        let child_directory_count = node
            .children
            .iter()
            .filter(|child| {
                self.directories
                    .get(*child)
                    .is_some_and(|value| !value.visible_subtree_files.is_empty())
            })
            .count();
        Some(WorkspaceEntry {
            id: node.id.clone(),
            kind: WorkspaceEntryKind::Directory,
            name: Path::new(&node.display_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&node.display_path)
                .to_owned(),
            canonical_path: node.display_path.clone(),
            file_id: None,
            modified_at_utc_ms: modified,
            size_bytes,
            source: "本机 NTFS 索引".to_owned(),
            file_count: node.visible_subtree_files.len(),
            child_directory_count,
            has_children: !self.entries_for_directory(path).is_empty(),
            value_summary: self.value_summary(&node.visible_subtree_files),
        })
    }

    fn file_entry(&self, file: &WorkspaceFile) -> WorkspaceEntry {
        WorkspaceEntry {
            id: format!("f:{}", file.record.id),
            kind: WorkspaceEntryKind::File,
            name: Path::new(&file.record.canonical_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&file.record.canonical_path)
                .to_owned(),
            canonical_path: file.record.canonical_path.clone(),
            file_id: Some(file.record.id),
            modified_at_utc_ms: file.record.modified_at_utc_ms,
            size_bytes: file.record.size_bytes,
            source: file.record.source.clone(),
            file_count: 1,
            child_directory_count: 0,
            has_children: false,
            value_summary: self.value_summary(&[file.record.id]),
        }
    }

    fn value_summary(&self, ids: &[i64]) -> WorkspaceValueSummary {
        let mut summary = WorkspaceValueSummary::default();
        for id in ids {
            match self.value_statuses.get(id).map(String::as_str) {
                Some("valuable" | "有价值") => summary.valuable += 1,
                Some("not_valuable" | "低价值") => summary.not_valuable += 1,
                Some("error" | "评估失败") => summary.failed += 1,
                Some("unsupported" | "无法解析") => summary.unsupported += 1,
                _ => summary.pending += 1,
            }
        }
        summary
    }
}

#[derive(Clone)]
pub struct WorkspaceQueryStore {
    shared: Arc<WorkspaceQueryStoreInner>,
}

struct WorkspaceQueryStoreInner {
    entries: Mutex<VecDeque<StoredWorkspaceQuery>>,
    next_id: AtomicU64,
    maximum_queries: usize,
    time_to_live: Duration,
}

struct StoredWorkspaceQuery {
    id: String,
    created_at: Instant,
    tree: WorkspaceTree,
    sort: WorkspaceSort,
}

impl Default for WorkspaceQueryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceQueryStore {
    pub fn new() -> Self {
        Self::with_limits(8, Duration::from_secs(10 * 60))
    }

    pub fn with_limits(maximum_queries: usize, time_to_live: Duration) -> Self {
        Self {
            shared: Arc::new(WorkspaceQueryStoreInner {
                entries: Mutex::new(VecDeque::new()),
                next_id: AtomicU64::new(1),
                maximum_queries: maximum_queries.max(1),
                time_to_live,
            }),
        }
    }

    pub fn insert(&self, tree: WorkspaceTree, sort: WorkspaceSort) -> Result<String, String> {
        let sequence = self.shared.next_id.fetch_add(1, AtomicOrdering::Relaxed);
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let id = format!("workspace-{epoch:x}-{sequence:x}");
        let mut entries = self
            .shared
            .entries
            .lock()
            .map_err(|_| "工作文件查询状态暂时不可用。".to_owned())?;
        remove_expired(&mut entries, self.shared.time_to_live);
        entries.push_back(StoredWorkspaceQuery {
            id: id.clone(),
            created_at: Instant::now(),
            tree,
            sort,
        });
        while entries.len() > self.shared.maximum_queries {
            entries.pop_front();
        }
        Ok(id)
    }

    pub fn page(
        &self,
        query_id: &str,
        parent_id: Option<&str>,
        cursor: usize,
    ) -> Result<WorkspacePage, String> {
        self.with_query(query_id, |query| {
            let mut page = query.tree.page(parent_id, cursor, 200, query.sort);
            page.query_id = query.id.clone();
            page
        })
    }

    pub fn resolve(
        &self,
        query_id: &str,
        file_ids: &[i64],
        directory_ids: &[String],
    ) -> Result<Vec<i64>, String> {
        self.with_query(query_id, |query| {
            query.tree.resolve(file_ids, directory_ids)
        })
    }

    pub fn directory_path(&self, query_id: &str, directory_id: &str) -> Result<String, String> {
        self.with_query(query_id, |query| {
            query.tree.directory_path(directory_id).map(str::to_owned)
        })?
        .ok_or_else(|| "该目录已不在当前查询中，请刷新列表。".to_owned())
    }

    pub fn all_visible_file_ids(&self, query_id: &str) -> Result<Vec<i64>, String> {
        self.with_query(query_id, |query| query.tree.visible_file_ids())
    }

    pub fn set_value_statuses(
        &self,
        query_id: &str,
        value_statuses: HashMap<i64, String>,
    ) -> Result<(), String> {
        let mut entries = self
            .shared
            .entries
            .lock()
            .map_err(|_| "工作文件查询状态暂时不可用。".to_owned())?;
        remove_expired(&mut entries, self.shared.time_to_live);
        let query = entries
            .iter_mut()
            .find(|query| query.id == query_id)
            .ok_or_else(|| "当前工作文件查询已过期，请刷新列表。".to_owned())?;
        query.tree.set_value_statuses(value_statuses);
        Ok(())
    }

    fn with_query<T>(
        &self,
        query_id: &str,
        operation: impl FnOnce(&StoredWorkspaceQuery) -> T,
    ) -> Result<T, String> {
        let mut entries = self
            .shared
            .entries
            .lock()
            .map_err(|_| "工作文件查询状态暂时不可用。".to_owned())?;
        remove_expired(&mut entries, self.shared.time_to_live);
        entries
            .iter()
            .find(|query| query.id == query_id)
            .map(operation)
            .ok_or_else(|| "当前工作文件查询已过期，请刷新列表。".to_owned())
    }
}

fn remove_expired(entries: &mut VecDeque<StoredWorkspaceQuery>, time_to_live: Duration) {
    entries.retain(|query| query.created_at.elapsed() < time_to_live);
}

fn ensure_directory_chain(
    directories: &mut HashMap<String, DirectoryNode>,
    display_path: &str,
    normalized_path: &str,
    root: &str,
) {
    let mut chain = Vec::<(String, String)>::new();
    let mut display = display_path.to_owned();
    let mut normalized = normalized_path.to_owned();
    while normalized != root && is_same_or_descendant(&normalized, root) {
        chain.push((normalized.clone(), display.clone()));
        let Some(parent) = Path::new(&display).parent() else {
            break;
        };
        display = parent.to_string_lossy().to_string();
        normalized = normalize_windows_path(&display);
    }
    chain.reverse();
    let mut parent = root.to_owned();
    for (normalized, display) in chain {
        directories.entry(normalized.clone()).or_insert_with(|| {
            DirectoryNode::new(display, normalized.clone(), Some(parent.clone()))
        });
        if let Some(parent_node) = directories.get_mut(&parent) {
            parent_node.children.insert(normalized.clone());
        }
        parent = normalized;
    }
}

fn sort_entries(entries: &mut [WorkspaceEntry], sort: WorkspaceSort) {
    entries.sort_by(|left, right| {
        let kind_order = match (left.kind, right.kind) {
            (WorkspaceEntryKind::Directory, WorkspaceEntryKind::File) => Ordering::Less,
            (WorkspaceEntryKind::File, WorkspaceEntryKind::Directory) => Ordering::Greater,
            _ => Ordering::Equal,
        };
        let name = || left.name.to_lowercase().cmp(&right.name.to_lowercase());
        let extension = || {
            Path::new(&left.name)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_lowercase()
                .cmp(
                    &Path::new(&right.name)
                        .extension()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_lowercase(),
                )
                .then_with(name)
        };
        match sort {
            WorkspaceSort::TimeAsc => left
                .modified_at_utc_ms
                .cmp(&right.modified_at_utc_ms)
                .then(kind_order)
                .then_with(name),
            WorkspaceSort::TimeDesc => right
                .modified_at_utc_ms
                .cmp(&left.modified_at_utc_ms)
                .then(kind_order)
                .then_with(name),
            WorkspaceSort::NameAsc => kind_order.then_with(name),
            WorkspaceSort::NameDesc => kind_order.then_with(|| name().reverse()),
            WorkspaceSort::TypeAsc => kind_order.then_with(extension),
            WorkspaceSort::TypeDesc => kind_order.then_with(|| extension().reverse()),
        }
    });
}

fn directory_id(path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("d:{:016x}", hasher.finish())
}

fn visible_windows_path(path: &str) -> String {
    if let Some(value) = path.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{value}");
    }
    path.strip_prefix("\\\\?\\").unwrap_or(path).to_owned()
}

fn normalize_windows_path(path: &str) -> String {
    let visible = visible_windows_path(path).replace('/', "\\");
    let trimmed = if visible.len() > 3 {
        visible.trim_end_matches('\\')
    } else {
        visible.as_str()
    };
    trimmed.to_lowercase()
}

fn is_same_or_descendant(path: &str, root: &str) -> bool {
    path == root
        || if root.ends_with('\\') {
            // A drive root remains `d:\\` after normalization. Its child
            // paths continue immediately with their first directory name,
            // unlike normal roots where a separator is still required.
            path.strip_prefix(root).is_some()
        } else {
            path.strip_prefix(root)
                .is_some_and(|suffix| suffix.starts_with('\\'))
        }
}

fn wildcard_matches(value: &str, pattern: &str) -> bool {
    let value = value.to_lowercase().chars().collect::<Vec<_>>();
    let pattern = pattern.to_lowercase().chars().collect::<Vec<_>>();
    let mut previous = vec![false; value.len() + 1];
    previous[0] = true;
    for token in pattern {
        let mut current = vec![false; value.len() + 1];
        if token == '*' {
            current[0] = previous[0];
        }
        for index in 1..=value.len() {
            current[index] = match token {
                '*' => previous[index] || current[index - 1],
                '?' => previous[index - 1],
                literal => previous[index - 1] && value[index - 1] == literal,
            };
        }
        previous = current;
    }
    previous[value.len()]
}
