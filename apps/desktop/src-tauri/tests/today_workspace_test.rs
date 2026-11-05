use std::collections::HashMap;

use qizhi_desktop_lib::{
    contracts::FileRecord,
    today_workspace::{
        WorkspaceBuildInput, WorkspaceCategory, WorkspaceEntryKind, WorkspaceSort, WorkspaceTree,
    },
};

fn file(id: i64, path: &str, modified_at_utc_ms: i64) -> FileRecord {
    FileRecord {
        id,
        canonical_path: path.to_owned(),
        file_identity: format!("identity-{id}"),
        modified_at_utc_ms,
        size_bytes: 10,
        source: "本机 NTFS 索引".to_owned(),
    }
}

fn build(
    files: Vec<FileRecord>,
    roots: &[&str],
    threshold: u16,
    category: WorkspaceCategory,
    search: &str,
) -> WorkspaceTree {
    WorkspaceTree::build(WorkspaceBuildInput {
        files,
        allowed_roots: roots.iter().map(|value| (*value).to_owned()).collect(),
        threshold,
        category,
        search: search.to_owned(),
        value_statuses: HashMap::new(),
    })
    .expect("workspace tree")
}

#[test]
fn directory_rows_aggregate_persisted_value_states() {
    let files = (1..=5)
        .map(|id| file(id, &format!(r"D:\Work\Reports\report-{id}.md"), id))
        .collect();
    let tree = WorkspaceTree::build(WorkspaceBuildInput {
        files,
        allowed_roots: vec![r"D:\Work".to_owned()],
        threshold: 5,
        category: WorkspaceCategory::Documents,
        search: String::new(),
        value_statuses: HashMap::from([
            (1, "valuable".to_owned()),
            (2, "valuable".to_owned()),
            (3, "not_valuable".to_owned()),
            (4, "error".to_owned()),
        ]),
    })
    .expect("tree");
    let page = tree.page(None, 0, 200, WorkspaceSort::NameAsc);
    let summary = &page.entries[0].value_summary;
    assert_eq!(summary.valuable, 2);
    assert_eq!(summary.not_valuable, 1);
    assert_eq!(summary.failed, 1);
    assert_eq!(summary.pending, 1);
}

#[test]
fn fifth_direct_file_turns_a_directory_into_one_group() {
    let four = (1..=4)
        .map(|id| file(id, &format!(r"D:\Work\Reports\report-{id}.md"), id))
        .collect();
    let four_page = build(four, &[r"D:\Work"], 5, WorkspaceCategory::All, "").page(
        None,
        0,
        200,
        WorkspaceSort::NameAsc,
    );
    assert_eq!(four_page.entries.len(), 4);
    assert!(
        four_page
            .entries
            .iter()
            .all(|entry| entry.kind == WorkspaceEntryKind::File)
    );

    let five = (1..=5)
        .map(|id| file(id, &format!(r"D:\Work\Reports\report-{id}.md"), id))
        .collect();
    let five_page = build(five, &[r"D:\Work"], 5, WorkspaceCategory::All, "").page(
        None,
        0,
        200,
        WorkspaceSort::NameAsc,
    );
    assert_eq!(five_page.entries.len(), 1);
    assert_eq!(five_page.entries[0].kind, WorkspaceEntryKind::Directory);
    assert_eq!(five_page.entries[0].name, "Reports");
    assert_eq!(five_page.entries[0].file_count, 5);
}

#[test]
fn drive_root_scan_scope_includes_files_in_its_descendants() {
    let tree = build(
        vec![file(
            1,
            r"D:\work\引擎\devsecops引擎方案.docx",
            1_793_759_457_000,
        )],
        &[r"D:\"],
        5,
        WorkspaceCategory::Documents,
        "",
    );

    let page = tree.page(None, 0, 200, WorkspaceSort::TimeDesc);

    assert_eq!(page.total_file_count, 1);
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].kind, WorkspaceEntryKind::File);
    assert_eq!(page.entries[0].name, "devsecops引擎方案.docx");
}

#[test]
fn five_changed_child_directories_trigger_a_group() {
    let files = (1..=5)
        .map(|id| file(id, &format!(r"D:\Work\Project\section-{id}\note.md"), id))
        .collect();
    let tree = build(files, &[r"D:\Work"], 5, WorkspaceCategory::All, "");
    let page = tree.page(None, 0, 200, WorkspaceSort::NameAsc);

    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].name, "Project");
    assert_eq!(page.entries[0].child_directory_count, 5);
    let children = tree.page(Some(&page.entries[0].id), 0, 200, WorkspaceSort::NameAsc);
    assert_eq!(children.entries.len(), 5);
    assert!(
        children
            .entries
            .iter()
            .all(|entry| entry.kind == WorkspaceEntryKind::Directory)
    );
}

#[test]
fn deepest_group_is_shown_under_its_direct_parent_context() {
    let files = (1..=5)
        .map(|id| file(id, &format!(r"D:\Work\ProjectA\src\file-{id}.rs"), id))
        .collect();
    let tree = build(files, &[r"D:\Work"], 5, WorkspaceCategory::All, "");
    let root = tree.page(None, 0, 200, WorkspaceSort::NameAsc);

    assert_eq!(root.entries.len(), 1);
    assert_eq!(root.entries[0].name, "ProjectA");
    let children = tree.page(Some(&root.entries[0].id), 0, 200, WorkspaceSort::NameAsc);
    assert_eq!(children.entries.len(), 1);
    assert_eq!(children.entries[0].name, "src");
    assert_eq!(children.entries[0].file_count, 5);
}

#[test]
fn sibling_deep_groups_share_one_context_parent() {
    let mut files = Vec::new();
    for id in 1..=5 {
        files.push(file(
            id,
            &format!(r"D:\Work\ProjectA\src\source-{id}.rs"),
            id,
        ));
        files.push(file(
            id + 10,
            &format!(r"D:\Work\ProjectA\docs\document-{id}.md"),
            id,
        ));
    }
    let tree = build(files, &[r"D:\Work"], 5, WorkspaceCategory::All, "");
    let root = tree.page(None, 0, 200, WorkspaceSort::NameAsc);
    assert_eq!(root.entries.len(), 1);
    assert_eq!(root.entries[0].name, "ProjectA");

    let children = tree.page(Some(&root.entries[0].id), 0, 200, WorkspaceSort::NameAsc);
    assert_eq!(
        children
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        vec!["docs", "src"]
    );
}

#[test]
fn longest_matching_root_owns_each_file_once() {
    let files = (1..=5)
        .map(|id| file(id, &format!(r"C:\Users\u\Desktop\Project\file-{id}.md"), id))
        .collect();
    let tree = build(
        files,
        &[r"C:\Users\u", r"C:\Users\u\Desktop"],
        5,
        WorkspaceCategory::All,
        "",
    );
    let page = tree.page(None, 0, 200, WorkspaceSort::NameAsc);

    assert_eq!(page.total_file_count, 5);
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].name, "Project");
    assert_ne!(page.entries[0].name, "Desktop");
}

#[test]
fn equivalent_extended_and_case_variant_paths_are_deduplicated() {
    let tree = build(
        vec![
            file(1, r"\\?\D:\Work\Notes\Plan.md", 1),
            file(2, r"d:\work\notes\plan.md", 2),
        ],
        &[r"D:\Work"],
        5,
        WorkspaceCategory::All,
        "",
    );
    let page = tree.page(None, 0, 200, WorkspaceSort::NameAsc);

    assert_eq!(page.total_file_count, 1);
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].kind, WorkspaceEntryKind::File);
}

#[test]
fn category_filter_runs_before_group_counts() {
    let mut files = (1..=4)
        .map(|id| file(id, &format!(r"D:\Work\Mixed\doc-{id}.md"), id))
        .collect::<Vec<_>>();
    files.push(file(10, r"D:\Work\Mixed\code.rs", 10));
    let page = build(files, &[r"D:\Work"], 5, WorkspaceCategory::Documents, "").page(
        None,
        0,
        200,
        WorkspaceSort::NameAsc,
    );

    assert_eq!(page.total_file_count, 4);
    assert_eq!(page.entries.len(), 4);
    assert!(
        page.entries
            .iter()
            .all(|entry| entry.kind == WorkspaceEntryKind::File)
    );
}

#[test]
fn recently_modified_unicode_document_is_visible_as_a_file_row() {
    let page = build(
        vec![
            file(1, r"D:\\work\\引擎\\devsecops引擎方案.docx", 200),
            file(2, r"D:\\work\\云栖大会参展内容准备工作.xlsx", 199),
        ],
        &[r"D:\\", r"D:\\code\\knowledge_function"],
        5,
        WorkspaceCategory::Documents,
        "",
    )
    .page(None, 0, 200, WorkspaceSort::TimeDesc);

    assert_eq!(page.total_file_count, 2);
    assert!(page.entries.iter().any(|entry| {
        entry.kind == WorkspaceEntryKind::File && entry.name == "devsecops引擎方案.docx"
    }));
}

#[test]
fn wildcard_search_prunes_files_but_preserves_the_existing_group() {
    let files = (1..=5)
        .map(|id| file(id, &format!(r"D:\Work\Reports\report-{id}.md"), id))
        .collect();
    let page = build(
        files,
        &[r"D:\Work"],
        5,
        WorkspaceCategory::Documents,
        "report-1*",
    )
    .page(None, 0, 200, WorkspaceSort::NameAsc);

    assert_eq!(page.total_file_count, 1);
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].kind, WorkspaceEntryKind::Directory);
    assert_eq!(page.entries[0].name, "Reports");
    assert_eq!(page.entries[0].file_count, 1);
}

#[test]
fn time_sort_surfaces_the_most_recent_file_ahead_of_an_older_directory_group() {
    let mut files = (1..=5)
        .map(|id| file(id, &format!(r"D:\Work\ZGroup\file-{id}.md"), id))
        .collect::<Vec<_>>();
    files.push(file(20, r"D:\Work\A-loose.md", 20));
    let tree = build(files, &[r"D:\Work"], 5, WorkspaceCategory::All, "");

    let by_name = tree.page(None, 0, 200, WorkspaceSort::NameAsc);
    assert_eq!(by_name.entries[0].kind, WorkspaceEntryKind::Directory);
    assert_eq!(by_name.entries[0].name, "ZGroup");
    assert_eq!(by_name.entries[0].modified_at_utc_ms, 5);

    let by_time = tree.page(None, 0, 200, WorkspaceSort::TimeDesc);
    assert_eq!(by_time.entries[0].kind, WorkspaceEntryKind::File);
    assert_eq!(by_time.entries[0].name, "A-loose.md");
    assert_eq!(by_time.entries[1].kind, WorkspaceEntryKind::Directory);
}

#[test]
fn a_large_flat_level_is_paged_and_selection_is_deduplicated() {
    let files = (1..=201)
        .map(|id| file(id, &format!(r"D:\Work\file-{id:03}.md"), id))
        .collect();
    let tree = build(files, &[r"D:\Work"], 5, WorkspaceCategory::All, "");
    let first = tree.page(None, 0, 200, WorkspaceSort::NameAsc);

    assert_eq!(first.entries.len(), 200);
    assert_eq!(first.next_cursor, Some(200));
    let second = tree.page(None, 200, 200, WorkspaceSort::NameAsc);
    assert_eq!(second.entries.len(), 1);
    assert_eq!(second.next_cursor, None);

    let all_ids = tree.resolve(&[1, 1], &[]);
    assert_eq!(all_ids, vec![1]);
}
