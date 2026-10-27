use std::path::PathBuf;

use chrono::{Local, TimeZone};

use crate::{database::AppError, scan::policy::AllowedRoot};

use super::port::{DiscoveredFile, DiscoveryHealth, FileDiscovery};

const REQUEST_FULL_PATH_AND_FILE_NAME: u32 = 0x0000_0004;
const REQUEST_SIZE: u32 = 0x0000_0010;
const REQUEST_DATE_MODIFIED: u32 = 0x0000_0040;
const REQUEST_FLAGS: u32 = REQUEST_FULL_PATH_AND_FILE_NAME | REQUEST_SIZE | REQUEST_DATE_MODIFIED;
const RESULT_LIMIT: usize = 500;

/// Native adapter for Voidtools' Everything SDK DLL. The DLL remains outside
/// the app package: the user selects its local `Everything64.dll` in Settings.
pub struct EverythingSdkDiscovery {
    library_path: Option<PathBuf>,
}

impl EverythingSdkDiscovery {
    pub fn new(library_path: PathBuf) -> Self {
        Self {
            library_path: Some(library_path),
        }
    }

    pub fn unconfigured() -> Self {
        Self { library_path: None }
    }

    fn library(&self) -> Result<SdkLibrary, AppError> {
        let path = self
            .library_path
            .as_deref()
            .ok_or(AppError::DiscoveryUnavailable)?;
        SdkLibrary::open(path)
    }
}

impl FileDiscovery for EverythingSdkDiscovery {
    fn name(&self) -> &'static str {
        "everything-sdk"
    }

    fn health(&self) -> DiscoveryHealth {
        match self.library() {
            Ok(_) => DiscoveryHealth {
                available: true,
                adapter: self.name().to_owned(),
                remediation: "Everything SDK 已连接；扫描时会校验 Everything 服务状态。".to_owned(),
            },
            _ => DiscoveryHealth {
                available: false,
                adapter: self.name().to_owned(),
                remediation: "Everything SDK DLL 未就绪，请确认 DLL 配置有效，或改用 es.exe。"
                    .to_owned(),
            },
        }
    }

    fn find_modified_between(
        &self,
        roots: &[AllowedRoot],
        start_utc_ms: i64,
        end_utc_ms: i64,
    ) -> Result<Vec<DiscoveredFile>, AppError> {
        if start_utc_ms >= end_utc_ms {
            return Err(AppError::DiscoveryInvalidData);
        }
        let start_date = local_date(start_utc_ms)?;
        let sdk = self.library()?;
        let mut files = Vec::new();
        for root in roots {
            if files.len() >= RESULT_LIMIT {
                break;
            }
            let query = format!(
                "file: dm:{start_date} path:\"{}\"",
                root.0.to_string_lossy()
            );
            sdk.query(&query, RESULT_LIMIT.saturating_sub(files.len()))?;
            files.extend(sdk.results(start_utc_ms, end_utc_ms)?);
        }
        files.truncate(RESULT_LIMIT);
        Ok(files)
    }
}

fn local_date(timestamp_ms: i64) -> Result<String, AppError> {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|value| value.format("%F").to_string())
        .ok_or(AppError::DiscoveryInvalidData)
}

#[cfg(windows)]
mod native {
    use std::{
        ffi::{c_char, c_void},
        os::windows::ffi::OsStrExt,
        path::Path,
    };

    use crate::database::AppError;

    use super::{DiscoveredFile, REQUEST_FLAGS};

    type SetSearchW = unsafe extern "system" fn(*const u16);
    type SetRequestFlags = unsafe extern "system" fn(u32);
    type SetMax = unsafe extern "system" fn(u32);
    type QueryW = unsafe extern "system" fn(i32) -> i32;
    type GetNumResults = unsafe extern "system" fn() -> u32;
    type GetResultFullPathNameW = unsafe extern "system" fn(u32, *mut u16, u32) -> u32;
    type GetResultSize = unsafe extern "system" fn(u32, *mut i64) -> i32;
    type GetResultDateModified = unsafe extern "system" fn(u32, *mut u64) -> i32;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryW(name: *const u16) -> *mut c_void;
        fn FreeLibrary(module: *mut c_void) -> i32;
        fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *const c_void;
        fn SetThreadErrorMode(new_mode: u32, old_mode: *mut u32) -> i32;
    }

    pub(super) struct SdkLibrary {
        module: *mut c_void,
        set_search: SetSearchW,
        set_request_flags: SetRequestFlags,
        set_max: SetMax,
        query_wait: QueryW,
        get_num_results: GetNumResults,
        get_full_path: GetResultFullPathNameW,
        get_size: GetResultSize,
        get_date_modified: GetResultDateModified,
    }

    impl SdkLibrary {
        pub(super) fn open(path: &Path) -> Result<Self, AppError> {
            if !path.is_file() {
                return Err(AppError::DiscoveryUnavailable);
            }
            let wide = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            // Suppress Windows' modal bad-image dialog for a misconfigured DLL.
            let mut previous_error_mode = 0_u32;
            let changed_error_mode =
                unsafe { SetThreadErrorMode(0x0001 | 0x8000, &mut previous_error_mode) != 0 };
            // The selected SDK path is only loaded after a local file check.
            let module = unsafe { LoadLibraryW(wide.as_ptr()) };
            if changed_error_mode {
                unsafe { SetThreadErrorMode(previous_error_mode, std::ptr::null_mut()) };
            }
            if module.is_null() {
                return Err(AppError::DiscoveryUnavailable);
            }
            let result = unsafe {
                Ok(Self {
                    module,
                    set_search: symbol(module, b"Everything_SetSearchW\0")?,
                    set_request_flags: symbol(module, b"Everything_SetRequestFlags\0")?,
                    set_max: symbol(module, b"Everything_SetMax\0")?,
                    query_wait: symbol(module, b"Everything_QueryW\0")?,
                    get_num_results: symbol(module, b"Everything_GetNumResults\0")?,
                    get_full_path: symbol(module, b"Everything_GetResultFullPathNameW\0")?,
                    get_size: symbol(module, b"Everything_GetResultSize\0")?,
                    get_date_modified: symbol(module, b"Everything_GetResultDateModified\0")?,
                })
            };
            if result.is_err() {
                // A partial load must not leave the SDK DLL resident.
                unsafe { FreeLibrary(module) };
            }
            result
        }

        pub(super) fn query(&self, search: &str, max: usize) -> Result<(), AppError> {
            let wide = search
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            unsafe {
                (self.set_search)(wide.as_ptr());
                (self.set_request_flags)(REQUEST_FLAGS);
                (self.set_max)(max.try_into().map_err(|_| AppError::DiscoveryInvalidData)?);
                if (self.query_wait)(1) == 0 {
                    return Err(AppError::DiscoveryUnavailable);
                }
            }
            Ok(())
        }

        pub(super) fn results(
            &self,
            start_utc_ms: i64,
            end_utc_ms: i64,
        ) -> Result<Vec<DiscoveredFile>, AppError> {
            let count = unsafe { (self.get_num_results)() };
            let mut results = Vec::with_capacity(count as usize);
            for index in 0..count {
                let path = self.full_path(index)?;
                let mut size = 0_i64;
                let mut filetime = 0_u64;
                let available = unsafe {
                    (self.get_size)(index, &mut size) != 0
                        && (self.get_date_modified)(index, &mut filetime) != 0
                };
                if !available || size < 0 {
                    continue;
                }
                let modified_at_utc_ms = filetime_to_unix_ms(filetime)?;
                if modified_at_utc_ms >= start_utc_ms && modified_at_utc_ms < end_utc_ms {
                    results.push(DiscoveredFile {
                        path,
                        size_bytes: size,
                        modified_at_utc_ms,
                    });
                }
            }
            Ok(results)
        }

        fn full_path(&self, index: u32) -> Result<String, AppError> {
            let mut buffer = vec![0_u16; 32_768];
            let written =
                unsafe { (self.get_full_path)(index, buffer.as_mut_ptr(), buffer.len() as u32) }
                    as usize;
            if written >= buffer.len() {
                return Err(AppError::DiscoveryInvalidData);
            }
            String::from_utf16(&buffer[..written]).map_err(|_| AppError::DiscoveryInvalidData)
        }
    }

    impl Drop for SdkLibrary {
        fn drop(&mut self) {
            unsafe { FreeLibrary(self.module) };
        }
    }

    unsafe fn symbol<T: Copy>(module: *mut c_void, name: &[u8]) -> Result<T, AppError> {
        let address = unsafe { GetProcAddress(module, name.as_ptr().cast()) };
        if address.is_null() {
            return Err(AppError::DiscoveryUnavailable);
        }
        // Everything's SDK exports the documented stdcall function signatures above.
        Ok(unsafe { std::mem::transmute_copy(&address) })
    }

    fn filetime_to_unix_ms(filetime: u64) -> Result<i64, AppError> {
        let milliseconds = filetime / 10_000;
        milliseconds
            .checked_sub(11_644_473_600_000)
            .and_then(|value| i64::try_from(value).ok())
            .ok_or(AppError::DiscoveryInvalidData)
    }
}

#[cfg(windows)]
use native::SdkLibrary;

#[cfg(not(windows))]
use std::path::Path;

#[cfg(not(windows))]
struct SdkLibrary;

#[cfg(not(windows))]
impl SdkLibrary {
    fn open(_: &Path) -> Result<Self, AppError> {
        Err(AppError::DiscoveryUnavailable)
    }
}
