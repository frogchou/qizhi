use std::{
    fs,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::codex::{CodexProjectFiles, MaterialImportStatus, ProjectFileError};

fn temporary_root(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("qizhi-codex-files-{name}-{nonce}"));
    fs::create_dir_all(&root).unwrap();
    root
}

fn write_ooxml(path: &Path, entry_name: &str, text: &str) {
    let file = fs::File::create(path).unwrap();
    let mut archive = zip::ZipWriter::new(file);
    archive
        .start_file(entry_name, zip::write::SimpleFileOptions::default())
        .unwrap();
    write!(archive, "<root><t>{text}</t></root>").unwrap();
    archive.finish().unwrap();
}

#[test]
fn creates_an_isolated_layout_and_rejects_untrusted_project_ids_and_paths() {
    let root = temporary_root("layout");
    let files = CodexProjectFiles::new(&root);
    let project_id = "22f06750-d98f-4f11-94f7-237ff6c3e6a1";
    let layout = files.create_layout(project_id).expect("layout");
    assert!(layout.materials_local.is_dir());
    assert!(layout.materials_ragflow.is_dir());
    assert!(layout.workspace.is_dir());
    assert!(layout.previews.is_dir());
    assert!(matches!(
        files.create_layout("../escape"),
        Err(ProjectFileError::InvalidProjectId)
    ));
    assert!(matches!(
        files.resolve_workspace_path(project_id, Path::new("../outside")),
        Err(ProjectFileError::UnsafePath)
    ));
    assert!(matches!(
        files.resolve_material_path(project_id, Path::new("C:\\Windows")),
        Err(ProjectFileError::UnsafePath)
    ));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn imports_text_and_ooxml_as_original_and_derived_snapshots() {
    let root = temporary_root("import");
    let source = root.join("sources");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("notes.md"), "# 周报\n完成验收").unwrap();
    write_ooxml(&source.join("plan.docx"), "word/document.xml", "年度计划");
    write_ooxml(
        &source.join("table.xlsx"),
        "xl/sharedStrings.xml",
        "预算数据",
    );
    write_ooxml(
        &source.join("slides.pptx"),
        "ppt/slides/slide1.xml",
        "汇报内容",
    );

    let files = CodexProjectFiles::new(root.join("projects"));
    let project_id = "afad0062-9f50-45ab-8b63-f38b1882d7bf";
    let imported = files
        .snapshot_local_files(
            project_id,
            &[
                source.join("notes.md"),
                source.join("plan.docx"),
                source.join("table.xlsx"),
                source.join("slides.pptx"),
            ],
        )
        .expect("imports");
    assert_eq!(imported.len(), 4);
    for item in imported {
        assert_eq!(item.status, MaterialImportStatus::Imported);
        assert!(
            item.original_snapshot_path
                .as_ref()
                .is_some_and(|path| path.exists())
        );
        let derived = item.derived_snapshot_path.expect("derived snapshot");
        assert!(derived.exists());
        assert!(!fs::read_to_string(derived).unwrap().trim().is_empty());
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn imports_source_and_other_project_files_without_requiring_document_extraction() {
    let root = temporary_root("project-files");
    let source = root.join("sources");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("main.rs"), "fn main() {}\n").unwrap();
    fs::write(source.join("asset.bin"), [0_u8, 159, 146, 150]).unwrap();

    let files = CodexProjectFiles::new(root.join("projects"));
    let project_id = "bf6a0d6b-47a0-4676-a328-68de763bc590";
    let imported = files
        .snapshot_local_files(
            project_id,
            &[source.join("main.rs"), source.join("asset.bin")],
        )
        .unwrap();

    assert_eq!(imported.len(), 2);
    assert_eq!(imported[0].status, MaterialImportStatus::Imported);
    assert!(
        imported[0]
            .derived_snapshot_path
            .as_ref()
            .is_some_and(|path| {
                fs::read_to_string(path).is_ok_and(|text| text.contains("fn main"))
            })
    );
    assert_eq!(imported[1].status, MaterialImportStatus::Imported);
    assert!(
        imported[1]
            .original_snapshot_path
            .as_ref()
            .is_some_and(|path| path.exists())
    );
    assert!(imported[1].derived_snapshot_path.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn deduplicates_content_rejects_legacy_office_and_defers_large_files() {
    let root = temporary_root("limits");
    let source = root.join("sources");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("a.txt"), "same content").unwrap();
    fs::write(source.join("b.txt"), "same content").unwrap();
    fs::write(source.join("legacy.doc"), "legacy").unwrap();
    let large = fs::File::create(source.join("large.txt")).unwrap();
    large.set_len(50 * 1024 * 1024 + 1).unwrap();

    let files = CodexProjectFiles::new(root.join("projects"));
    let project_id = "1fef1f8e-f83f-49dd-b7cf-a5db75b1f2f2";
    let result = files
        .snapshot_local_files(
            project_id,
            &[
                source.join("a.txt"),
                source.join("b.txt"),
                source.join("large.txt"),
            ],
        )
        .unwrap();
    assert_eq!(result[0].status, MaterialImportStatus::Imported);
    assert_eq!(result[1].status, MaterialImportStatus::Duplicate);
    assert_eq!(result[2].status, MaterialImportStatus::ConfirmationRequired);
    assert!(matches!(
        files.snapshot_local_files(project_id, &[source.join("legacy.doc")]),
        Err(ProjectFileError::UnsupportedFormat(_))
    ));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn scans_only_regular_workspace_files_as_artifacts() {
    let root = temporary_root("artifacts");
    let files = CodexProjectFiles::new(&root);
    let project_id = "2ef553d9-2c68-44e2-b680-c53d34ac77f7";
    let layout = files.create_layout(project_id).unwrap();
    fs::create_dir_all(layout.workspace.join("report")).unwrap();
    fs::write(layout.workspace.join("report/result.md"), "done").unwrap();
    let artifacts = files.scan_artifacts(project_id).unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].relative_path, Path::new("report/result.md"));
    assert_eq!(artifacts[0].size_bytes, 4);
    let _ = fs::remove_dir_all(root);
}
