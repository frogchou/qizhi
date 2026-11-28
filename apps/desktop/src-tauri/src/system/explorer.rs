use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use crate::{
    database::{AppError, repositories::FileRepository},
    scan::policy::ScanPolicy,
};

pub trait ProcessLauncher: Send + Sync {
    fn launch(&self, program: &str, args: &[String]) -> Result<(), AppError>;
}

pub struct SystemProcessLauncher;

impl ProcessLauncher for SystemProcessLauncher {
    fn launch(&self, program: &str, args: &[String]) -> Result<(), AppError> {
        #[cfg(target_os = "macos")]
        return Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .ok()
            .filter(std::process::ExitStatus::success)
            .map(|_| ())
            .ok_or(AppError::Storage);
        #[cfg(not(target_os = "macos"))]
        Command::new(program)
            .args(args)
            .spawn()
            .map(|_| ())
            .map_err(|_| AppError::Storage)
    }
}

pub(crate) enum FileAction {
    Open,
    Reveal,
    EditText,
}

pub(crate) fn file_command(action: FileAction, path: &Path) -> (&'static str, Vec<String>) {
    let path = path.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    return (
        "/usr/bin/open",
        match action {
            FileAction::Open => vec![path],
            FileAction::Reveal => vec!["-R".to_owned(), path],
            FileAction::EditText => vec!["-a".to_owned(), "TextEdit".to_owned(), path],
        },
    );
    #[cfg(not(target_os = "macos"))]
    match action {
        FileAction::Open => ("explorer.exe", vec![path]),
        FileAction::Reveal => ("explorer.exe", vec![format!("/select,{path}")]),
        FileAction::EditText => ("notepad.exe", vec![path]),
    }
}

pub struct ExplorerLauncher {
    files: FileRepository,
    policy: ScanPolicy,
    process: Arc<dyn ProcessLauncher>,
}

impl ExplorerLauncher {
    pub fn new(
        files: FileRepository,
        policy: ScanPolicy,
        process: Arc<dyn ProcessLauncher>,
    ) -> Self {
        Self {
            files,
            policy,
            process,
        }
    }

    pub fn reveal(&self, file_id: i64) -> Result<(), AppError> {
        let file = self.allowed_path(file_id)?;
        self.launch_file(FileAction::Reveal, &file)
    }

    pub fn open(&self, file_id: i64) -> Result<(), AppError> {
        let file = self.allowed_path(file_id)?;
        self.launch_file(FileAction::Open, &file)
    }

    pub fn open_in_text_editor(&self, file_id: i64) -> Result<(), AppError> {
        let file = self.allowed_path(file_id)?;
        self.launch_file(FileAction::EditText, &file)
    }

    pub fn open_directory_path(&self, path: &Path) -> Result<(), AppError> {
        if !self.policy.is_allowed_directory(path) {
            return Err(AppError::InvalidConfig);
        }
        self.launch_file(FileAction::Open, path)
    }

    pub fn copy_to_clipboard(&self, file_id: i64) -> Result<(), AppError> {
        let file = self.allowed_path(file_id)?;
        set_file_drop_clipboard(&file)
    }

    pub fn delete(&self, file_id: i64) -> Result<(), AppError> {
        let file = self.allowed_path(file_id)?;
        #[cfg(target_os = "macos")]
        trash_file(&file)?;
        #[cfg(not(target_os = "macos"))]
        std::fs::remove_file(file).map_err(|_| AppError::Storage)?;
        self.files.delete_by_id(file_id)
    }

    fn allowed_path(&self, file_id: i64) -> Result<PathBuf, AppError> {
        let file = self
            .files
            .get_by_id(file_id)?
            .ok_or(AppError::InvalidConfig)?;
        let path = PathBuf::from(&file.canonical_path);
        if !path.is_file() || !self.policy.is_allowed_record(&file) {
            return Err(AppError::InvalidConfig);
        }
        Ok(path)
    }

    fn launch_file(&self, action: FileAction, path: &Path) -> Result<(), AppError> {
        let (program, arguments) = file_command(action, path);
        self.process.launch(program, &arguments)
    }
}

#[cfg(target_os = "windows")]
fn set_file_drop_clipboard(path: &Path) -> Result<(), AppError> {
    use std::{
        mem::size_of,
        os::windows::ffi::OsStrExt,
        ptr::{copy_nonoverlapping, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{GlobalFree, HANDLE},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GMEM_MOVEABLE, GMEM_ZEROINIT, GlobalAlloc, GlobalLock, GlobalUnlock},
            Ole::CF_HDROP,
        },
    };

    #[repr(C)]
    struct DropFiles {
        offset: u32,
        x: i32,
        y: i32,
        non_client: i32,
        wide: i32,
    }

    let mut encoded = path.as_os_str().encode_wide().collect::<Vec<u16>>();
    encoded.extend([0, 0]);
    let size = size_of::<DropFiles>() + std::mem::size_of_val(encoded.as_slice());
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size);
        if memory.is_null() {
            return Err(AppError::Storage);
        }
        let pointer = GlobalLock(memory);
        if pointer.is_null() {
            let _ = GlobalFree(memory);
            return Err(AppError::Storage);
        }
        let drop_files = DropFiles {
            offset: size_of::<DropFiles>() as u32,
            x: 0,
            y: 0,
            non_client: 0,
            wide: 1,
        };
        copy_nonoverlapping(
            (&drop_files as *const DropFiles).cast::<u8>(),
            pointer.cast::<u8>(),
            size_of::<DropFiles>(),
        );
        copy_nonoverlapping(
            encoded.as_ptr().cast::<u8>(),
            pointer.cast::<u8>().add(size_of::<DropFiles>()),
            std::mem::size_of_val(encoded.as_slice()),
        );
        let _ = GlobalUnlock(memory);
        if OpenClipboard(null_mut()) == 0 {
            let _ = GlobalFree(memory);
            return Err(AppError::Storage);
        }
        let result = if EmptyClipboard() != 0
            && !SetClipboardData(CF_HDROP as u32, memory as HANDLE).is_null()
        {
            Ok(())
        } else {
            Err(AppError::Storage)
        };
        let _ = CloseClipboard();
        if result.is_err() {
            let _ = GlobalFree(memory);
        }
        result
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn set_file_drop_clipboard(path: &Path) -> Result<(), AppError> {
    use objc2_app_kit::NSPasteboard;

    objc2::rc::autoreleasepool(|_| {
        write_file_to_pasteboard(path, &NSPasteboard::generalPasteboard())
    })
}

#[cfg(target_os = "macos")]
fn write_file_to_pasteboard(
    path: &Path,
    pasteboard: &objc2_app_kit::NSPasteboard,
) -> Result<(), AppError> {
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::{NSArray, NSString, NSURL};

    let path = path.to_str().ok_or(AppError::InvalidConfig)?;
    let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(path), false);
    let objects = NSArray::from_slice(&[ProtocolObject::from_ref(&*url)]);
    pasteboard.clearContents();
    pasteboard
        .writeObjects(&objects)
        .then_some(())
        .ok_or(AppError::Storage)
}

#[cfg(target_os = "macos")]
fn trash_file(path: &Path) -> Result<(), AppError> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let path = path.to_str().ok_or(AppError::InvalidConfig)?;
    objc2::rc::autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(path), false);
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|_| AppError::Storage)
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn set_file_drop_clipboard(_path: &Path) -> Result<(), AppError> {
    Err(AppError::Storage)
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::*;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};

    #[test]
    fn macos_copy_writes_a_finder_file_url_to_an_isolated_pasteboard() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("文件 名.md");
        std::fs::write(&file, "fixture").unwrap();
        objc2::rc::autoreleasepool(|_| {
            let pasteboard = NSPasteboard::pasteboardWithUniqueName();
            write_file_to_pasteboard(&file, &pasteboard).unwrap();
            let file_type = unsafe { NSPasteboardTypeFileURL };
            let stored = pasteboard
                .stringForType(file_type)
                .expect("file URL pasteboard type");
            let url = url::Url::parse(&stored.to_string()).unwrap();
            assert_eq!(url.to_file_path().unwrap(), file);
        });
    }

    #[test]
    #[ignore = "moves a unique generated test fixture to the login user's Trash"]
    fn macos_trash_moves_only_the_selected_fixture() {
        let directory = tempfile::tempdir().unwrap();
        let name = format!("qizhi-trash-smoke-{}.md", uuid::Uuid::new_v4());
        let file = directory.path().canonicalize().unwrap().join(&name);
        std::fs::write(&file, &name).unwrap();
        trash_file(&file).unwrap();
        assert!(!file.exists());

        if let Some(home) = std::env::home_dir() {
            let trash = home.join(".Trash").join(&name);
            if std::fs::read_to_string(&trash).is_ok_and(|contents| contents == name) {
                std::fs::remove_file(trash).unwrap();
            }
        }
    }
}
