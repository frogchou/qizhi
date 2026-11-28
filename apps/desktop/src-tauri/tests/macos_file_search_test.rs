#![cfg(target_os = "macos")]

use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    file_index::macos::{FileSearchInput, FileSearchPage, MacRootState, MacWorkspaceIndex},
    scan::configuration::{ScanRuleStore, ScanRules},
};

struct Fixture {
    parent: tempfile::TempDir,
    root: PathBuf,
    rules: ScanRuleStore,
}

impl Fixture {
    fn new() -> Self {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().canonicalize().unwrap().join("授权资料");
        fs::create_dir(&root).unwrap();
        let rules = ScanRuleStore::open(
            &parent.path().join("rules.json"),
            ScanRules {
                allowed_roots: vec![root.to_str().unwrap().to_owned()],
                ..Default::default()
            },
        )
        .unwrap();
        Self {
            parent,
            root,
            rules,
        }
    }

    fn write(&self, relative: &str) -> PathBuf {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "fixture").unwrap();
        path
    }

    fn start(&self) -> MacWorkspaceIndex {
        self.start_within(Duration::from_secs(10))
    }

    fn start_within(&self, timeout: Duration) -> MacWorkspaceIndex {
        let index = MacWorkspaceIndex::open(self.parent.path(), self.rules.clone());
        let deadline = Instant::now() + timeout;
        loop {
            let page = search(&index, "", None);
            if page
                .coverage
                .first()
                .is_some_and(|root| root.state == MacRootState::Ready)
            {
                return index;
            }
            assert!(
                Instant::now() < deadline,
                "wait for the file index to be ready"
            );
            thread::sleep(Duration::from_millis(30));
        }
    }
}

#[test]
#[ignore = "benchmarks 100,000 real local APFS files and 50 FSEvents updates"]
fn measures_real_search_rebuild_and_incremental_updates() {
    let fixture = Fixture::new();
    let mut manifest = Vec::with_capacity(100_000);
    for folder in 0..100 {
        let directory = fixture.root.join(format!("projects-{folder:03}"));
        fs::create_dir(&directory).unwrap();
        for number in 0..1000 {
            let extension = if number % 2 == 0 { "pdf" } else { "md" };
            let name = format!("合同-report-{folder:03}-{number:04}.{extension}");
            let path = directory.join(name);
            fs::write(&path, b"fixed fixture").unwrap();
            manifest.push(path);
        }
    }
    assert_eq!(manifest.len(), 100_000);
    let started = Instant::now();
    let index = fixture.start_within(Duration::from_secs(300));
    let first_index_ms = started.elapsed().as_millis();
    let query_terms = [
        "合",
        "合同",
        ".pdf",
        "projects-047/合同",
        "047-0100",
        "report",
        "MD",
        "合约不存在",
    ];
    let expected = query_terms
        .iter()
        .map(|query| {
            manifest
                .iter()
                .filter(|path| path.to_str().unwrap().contains(&query.to_ascii_lowercase()))
                .count()
        })
        .collect::<Vec<_>>();
    let mut hot = Vec::new();
    for query in query_terms.iter().cycle().take(104) {
        let started = Instant::now();
        let page = search(&index, query, None);
        hot.push((query, started.elapsed().as_secs_f64() * 1000.0));
        let position = query_terms.iter().position(|term| term == query).unwrap();
        assert_eq!(
            page.files.len(),
            expected[position].min(50),
            "query {query}"
        );
        assert_eq!(
            page.next_cursor.is_some(),
            expected[position] > 50,
            "query {query}"
        );
        assert!(
            page.files
                .iter()
                .all(|file| file.path.contains(&query.to_ascii_lowercase())
                    && Path::new(&file.path).is_file())
        );
    }
    let mut mutations = Vec::new();
    for number in 0..50 {
        let query = format!("单文件实时变动-{number:03}");
        let started = Instant::now();
        fixture.write(&format!("live/{query}.txt"));
        while search(&index, &query, None).files.is_empty() {
            assert!(
                started.elapsed() < Duration::from_secs(8),
                "wait for FSEvents visibility"
            );
            thread::sleep(Duration::from_millis(25));
        }
        mutations.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    drop(index);
    let index_size_bytes = fs::metadata(fixture.parent.path().join("mac-file-index.sqlite3"))
        .unwrap()
        .len();
    fixture.write("live/离线新增验收.md");
    let restarted = Instant::now();
    let index = fixture.start_within(Duration::from_secs(30));
    while search(&index, "离线新增验收", None).files.is_empty() {
        assert!(
            restarted.elapsed() < Duration::from_secs(10),
            "resume the saved FSEvents cursor"
        );
        thread::sleep(Duration::from_millis(25));
    }
    println!(
        "QIZHI_SEARCH_BENCHMARK {}",
        serde_json::json!({
            "fileCount": manifest.len(),
            "firstIndexMs": first_index_ms,
            "hotQueryMs": hot,
            "mutationMs": mutations,
            "resumeMs": restarted.elapsed().as_millis(),
            "indexSizeBytes": index_size_bytes,
        })
    );
    drop(index);
    if std::env::var_os("QIZHI_KEEP_SEARCH_BENCHMARK_FIXTURE").is_some() {
        println!(
            "QIZHI_SEARCH_BENCHMARK_FIXTURE {}",
            fixture.parent.keep().display()
        );
    }
}

fn search(index: &MacWorkspaceIndex, query: &str, cursor: Option<String>) -> FileSearchPage {
    index
        .search(FileSearchInput {
            query: query.to_owned(),
            cursor,
        })
        .unwrap()
}

#[test]
fn matches_short_chinese_literal_fragments_unicode_and_the_full_path() {
    let fixture = Fixture::new();
    let old = fixture.write("Projects/甲方/Café 合同.pdf");
    fs::File::open(&old)
        .unwrap()
        .set_times(
            fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1_500_000_000)),
        )
        .unwrap();
    fixture.write("Projects/乙方/旧件.asset");
    fixture.write("备份/重命名\"企划.txt");
    fixture.write("备份/ΟΣ Maße.txt");
    let index = fixture.start();

    for term in [
        "合",
        "合同",
        ".pdf",
        "projects/甲方",
        "CAFE\u{301}",
        "甲方/Ca",
    ] {
        let page = search(&index, term, None);
        assert_eq!(page.files.len(), 1, "{term}");
        assert_eq!(Path::new(&page.files[0].path), old);
        assert_eq!(page.files[0].modified_at_utc_ms, 1_500_000_000_000);
    }
    assert_eq!(search(&index, "名\"企", None).files.len(), 1);
    assert_eq!(search(&index, ".asset", None).files.len(), 1);
    assert_eq!(search(&index, "ος", None).files.len(), 1);
    assert_eq!(search(&index, "MASSE", None).files.len(), 1);
    assert_eq!(search(&index, "授权", None).files.len(), 4);
    assert_eq!(search(&index, "料/", None).files.len(), 4);
    assert!(search(&index, "  ", None).files.is_empty());
    assert!(search(&index, "* OR unknown", None).files.is_empty());
}

#[test]
fn pages_same_named_files_without_duplicates_and_prioritizes_name_matches() {
    let fixture = Fixture::new();
    let exact = fixture.write("exact/计划");
    for number in 0..50 {
        fixture.write(&format!("folder-{number:02}/计划.md"));
    }
    let path_only = fixture.write("计划归档/备份.md");
    let index = fixture.start();
    let first = search(&index, "计划", None);
    assert_eq!(first.files.len(), 50);
    assert_eq!(Path::new(&first.files[0].path), exact);
    fixture.write("与关键词无关.md");
    wait_for_match(&index, "与关键词无关");
    let second = search(&index, "计划", first.next_cursor.clone());
    assert_eq!(second.files.len(), 2);
    assert!(second.next_cursor.is_none());
    assert_eq!(Path::new(&second.files[1].path), path_only);
    let all_keys = first
        .files
        .iter()
        .chain(second.files.iter())
        .map(|file| &file.record_key)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(all_keys.len(), 52);
    assert!(
        index
            .search(FileSearchInput {
                query: ".md".into(),
                cursor: first.next_cursor
            })
            .is_err()
    );
}

fn wait_for_match(index: &MacWorkspaceIndex, query: &str) -> FileSearchPage {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let page = search(index, query, None);
        if !page.files.is_empty() {
            return page;
        }
        assert!(
            Instant::now() < deadline,
            "wait for a native match: {query}"
        );
        thread::sleep(Duration::from_millis(40));
    }
}

#[test]
fn case_only_rename_publishes_one_actual_directory_entry() {
    let fixture = Fixture::new();
    let original = fixture.write("甲方/Report-Z1.md");
    let index = fixture.start();
    let old_key = wait_for_match(&index, "report-z1").files[0]
        .record_key
        .clone();
    let renamed = original.with_file_name("REPORT-Z1.md");
    fs::rename(&original, &renamed).unwrap();
    assert!(index.resolve_search_record(&old_key).is_err());
    let page = wait_for_match(&index, "report-z1");
    assert_eq!(page.files.len(), 1);
    assert_eq!(Path::new(&page.files[0].path), renamed);
}

#[test]
fn renamed_configured_root_is_unavailable_until_selected_again() {
    let fixture = Fixture::new();
    fixture.write("甲方/Report-Z2.md");
    let index = fixture.start();
    let old_key = wait_for_match(&index, "report-z2").files[0]
        .record_key
        .clone();
    // Renaming a lexical ancestor leaves an APFS spelling alias on a default volume.
    let intermediate = fixture.parent.path().canonicalize().unwrap().join("Work");
    fs::rename(&fixture.root, &intermediate).unwrap();
    let mut rules = fixture.rules.get().unwrap();
    rules.allowed_roots = vec![intermediate.to_str().unwrap().to_owned()];
    fixture.rules.save(rules).unwrap();
    let key = wait_for_match(&index, "report-z2").files[0]
        .record_key
        .clone();
    assert!(index.resolve_search_record(&old_key).is_err());
    fs::rename(&intermediate, intermediate.with_file_name("WORK")).unwrap();
    let page = search(&index, "report-z2", None);
    assert!(page.files.is_empty());
    assert_eq!(page.coverage[0].state, MacRootState::Unavailable);
    assert!(index.resolve_search_record(&key).is_err());
}

#[test]
fn a_ready_overlapping_root_cannot_borrow_an_unavailable_roots_old_membership() {
    let fixture = Fixture::new();
    let file = fixture.write("内层/不应从外层展示.md");
    let nested = file.parent().unwrap().to_string_lossy().into_owned();
    let mut rules = fixture.rules.get().unwrap();
    rules.allowed_roots.push(nested.clone());
    fixture.rules.save(rules).unwrap();
    let index = fixture.start();
    let visible = wait_for_match(&index, "不应从外层展示");
    assert_eq!(visible.coverage.len(), 2);
    let key = &visible.files[0].record_key;
    let connection =
        rusqlite::Connection::open(fixture.parent.path().join("mac-file-index.sqlite3")).unwrap();
    let outer = fixture.root.to_str().unwrap();
    connection
        .execute(
            "UPDATE scan_roots SET state = CASE WHEN path = ?1 THEN 2 ELSE 3 END",
            [outer],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO blocked_directories (root, path) VALUES (?1, ?2)",
            [outer, &nested],
        )
        .unwrap();
    assert!(search(&index, "不应从外层展示", None).files.is_empty());
    assert!(index.resolve_search_record(key).is_err());
}

#[test]
fn rejects_stale_search_keys_after_same_path_replacement_or_range_change() {
    let fixture = Fixture::new();
    let cached = fixture.write("审核/共享合同.md");
    let index = fixture.start();
    let old_key = search(&index, "共享合同", None).files.remove(0).record_key;
    assert!(index.resolve_search_record(&old_key).is_ok());

    fs::rename(&cached, cached.with_file_name("移走.md")).unwrap();
    fs::write(&cached, "different identity").unwrap();
    assert!(index.resolve_search_record(&old_key).is_err());
    let deadline = Instant::now() + Duration::from_secs(10);
    let new_key = loop {
        if let Some(result) = search(&index, "共享合同", None).files.into_iter().next()
            && result.record_key != old_key
        {
            break result.record_key;
        }
        assert!(Instant::now() < deadline, "wait for FSEvents replacement");
        thread::sleep(Duration::from_millis(50));
    };
    let mut rules = fixture.rules.get().unwrap();
    rules.custom_exclusions = vec![cached.parent().unwrap().to_str().unwrap().to_owned()];
    fixture.rules.save(rules).unwrap();
    assert!(index.resolve_search_record(&new_key).is_err());
    assert!(search(&index, "共享合同", None).files.is_empty());
}
