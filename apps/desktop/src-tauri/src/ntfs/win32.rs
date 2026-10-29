#[cfg(windows)]
use std::{ffi::c_void, mem::size_of};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    },
    System::{
        IO::DeviceIoControl,
        Ioctl::{
            FSCTL_ENUM_USN_DATA, FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL, MFT_ENUM_DATA_V0,
            READ_USN_JOURNAL_DATA_V0, USN_JOURNAL_DATA_V0,
        },
    },
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Win32Failure {
    pub operation: &'static str,
    pub code: u32,
}

impl std::fmt::Display for Win32Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} failed with Windows error {}",
            self.operation, self.code
        )
    }
}

impl std::error::Error for Win32Failure {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalMetadata {
    pub journal_id: String,
    pub first_usn: i64,
    pub next_usn: i64,
    pub lowest_valid_usn: i64,
}

#[cfg(windows)]
pub struct VolumeHandle(HANDLE);

#[cfg(windows)]
impl Drop for VolumeHandle {
    fn drop(&mut self) {
        unsafe {
            // This type owns the handle and is only constructed after CreateFileW succeeds.
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
pub fn open_volume(mount_path: &str) -> Result<VolumeHandle, Win32Failure> {
    let letter = mount_path
        .chars()
        .next()
        .filter(|value| value.is_ascii_alphabetic())
        .ok_or(Win32Failure {
            operation: "open NTFS volume",
            code: 87,
        })?;
    let device_path = format!(r"\\.\{}:", letter.to_ascii_uppercase());
    let wide_path = device_path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        // Path is NUL-terminated; no security attributes or template handle are supplied.
        CreateFileW(
            wide_path.as_ptr(),
            FILE_READ_DATA,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error("open NTFS volume"));
    }
    Ok(VolumeHandle(handle))
}

#[cfg(windows)]
pub fn query_journal(handle: &VolumeHandle) -> Result<JournalMetadata, Win32Failure> {
    let mut data = USN_JOURNAL_DATA_V0::default();
    control(
        handle,
        FSCTL_QUERY_USN_JOURNAL,
        std::ptr::null(),
        0,
        (&mut data as *mut USN_JOURNAL_DATA_V0).cast(),
        size_of::<USN_JOURNAL_DATA_V0>() as u32,
        "query USN journal",
    )?;
    Ok(JournalMetadata {
        journal_id: data.UsnJournalID.to_string(),
        first_usn: data.FirstUsn,
        next_usn: data.NextUsn,
        lowest_valid_usn: data.LowestValidUsn,
    })
}

#[cfg(windows)]
pub fn enumerate_usn_page(
    handle: &VolumeHandle,
    start_file_reference_number: u64,
    low_usn: i64,
    high_usn: i64,
) -> Result<Vec<u8>, Win32Failure> {
    let input = MFT_ENUM_DATA_V0 {
        StartFileReferenceNumber: start_file_reference_number,
        LowUsn: low_usn,
        HighUsn: high_usn,
    };
    control_into_vec(
        handle,
        FSCTL_ENUM_USN_DATA,
        (&input as *const MFT_ENUM_DATA_V0).cast(),
        size_of::<MFT_ENUM_DATA_V0>() as u32,
        "enumerate NTFS metadata",
    )
}

#[cfg(windows)]
pub fn read_usn_page(
    handle: &VolumeHandle,
    start_usn: i64,
    journal_id: u64,
) -> Result<Vec<u8>, Win32Failure> {
    let input = READ_USN_JOURNAL_DATA_V0 {
        StartUsn: start_usn,
        ReasonMask: u32::MAX,
        ReturnOnlyOnClose: 0,
        Timeout: 0,
        BytesToWaitFor: 0,
        UsnJournalID: journal_id,
    };
    control_into_vec(
        handle,
        FSCTL_READ_USN_JOURNAL,
        (&input as *const READ_USN_JOURNAL_DATA_V0).cast(),
        size_of::<READ_USN_JOURNAL_DATA_V0>() as u32,
        "read USN journal",
    )
}

#[cfg(windows)]
fn control_into_vec(
    handle: &VolumeHandle,
    control_code: u32,
    input: *const c_void,
    input_length: u32,
    operation: &'static str,
) -> Result<Vec<u8>, Win32Failure> {
    let mut output = vec![0_u8; 64 * 1024];
    let count = control(
        handle,
        control_code,
        input,
        input_length,
        output.as_mut_ptr().cast(),
        output.len() as u32,
        operation,
    )?;
    output.truncate(count as usize);
    Ok(output)
}

#[cfg(windows)]
fn control(
    handle: &VolumeHandle,
    control_code: u32,
    input: *const c_void,
    input_length: u32,
    output: *mut c_void,
    output_length: u32,
    operation: &'static str,
) -> Result<u32, Win32Failure> {
    let mut returned = 0_u32;
    let succeeded = unsafe {
        // Handle ownership is retained by VolumeHandle; all input/output pointers point to live buffers for the duration of this synchronous call.
        DeviceIoControl(
            handle.0,
            control_code,
            input,
            input_length,
            output,
            output_length,
            &mut returned,
            std::ptr::null_mut(),
        ) != 0
    };
    if !succeeded {
        return Err(last_error(operation));
    }
    Ok(returned)
}

#[cfg(windows)]
fn last_error(operation: &'static str) -> Win32Failure {
    Win32Failure {
        operation,
        code: unsafe {
            // GetLastError reads the thread-local result of the immediately preceding failing Win32 call.
            GetLastError()
        },
    }
}
