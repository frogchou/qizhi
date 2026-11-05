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

pub struct WindowsProcessLauncher;

impl ProcessLauncher for WindowsProcessLauncher {
    fn launch(&self, program: &str, args: &[String]) -> Result<(), AppError> {
        Command::new(program)
            .args(args)
            .spawn()
            .map(|_| ())
            .map_err(|_| AppError::Storage)
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
        self.process.launch(
            "explorer.exe",
            &[format!("/select,{}", file.to_string_lossy())],
        )
    }

    pub fn open(&self, file_id: i64) -> Result<(), AppError> {
        let file = self.allowed_path(file_id)?;
        self.process
            .launch("explorer.exe", &[file.to_string_lossy().to_string()])
    }

    pub fn open_in_text_editor(&self, file_id: i64) -> Result<(), AppError> {
        let file = self.allowed_path(file_id)?;
        self.process
            .launch("notepad.exe", &[file.to_string_lossy().to_string()])
    }

    pub fn open_directory_path(&self, path: &Path) -> Result<(), AppError> {
        if !self.policy.is_allowed_directory(path) {
            return Err(AppError::InvalidConfig);
        }
        self.process
            .launch("explorer.exe", &[path.to_string_lossy().to_string()])
    }

    pub fn copy_to_clipboard(&self, file_id: i64) -> Result<(), AppError> {
        let file = self.allowed_path(file_id)?;
        set_file_drop_clipboard(&file)
    }

    pub fn delete(&self, file_id: i64) -> Result<(), AppError> {
        let file = self.allowed_path(file_id)?;
        std::fs::remove_file(file).map_err(|_| AppError::Storage)?;
        self.files.delete_by_id(file_id)
    }

    fn allowed_path(&self, file_id: i64) -> Result<PathBuf, AppError> {
        let file = self
            .files
            .get_by_id(file_id)?
            .ok_or(AppError::InvalidConfig)?;
        let path = PathBuf::from(file.canonical_path);
        if !path.is_file() || !self.policy.is_allowed(&path) {
            return Err(AppError::InvalidConfig);
        }
        Ok(path)
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
            && SetClipboardData(CF_HDROP as u32, memory as HANDLE) != null_mut()
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

#[cfg(not(target_os = "windows"))]
fn set_file_drop_clipboard(_path: &Path) -> Result<(), AppError> {
    Err(AppError::Storage)
}
