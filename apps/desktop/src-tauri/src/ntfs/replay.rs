#[cfg(windows)]
use crate::ntfs::{
    usn::{UsnParseError, UsnReadPage, parse_usn_page},
    win32::{VolumeHandle, Win32Failure, read_usn_page},
};

#[cfg(windows)]
#[derive(Debug)]
pub enum ReplayError {
    Windows(Win32Failure),
    Parse(UsnParseError),
}

#[cfg(windows)]
impl From<Win32Failure> for ReplayError {
    fn from(value: Win32Failure) -> Self {
        Self::Windows(value)
    }
}

#[cfg(windows)]
impl From<UsnParseError> for ReplayError {
    fn from(value: UsnParseError) -> Self {
        Self::Parse(value)
    }
}

#[cfg(windows)]
pub fn read_replay_page(
    handle: &VolumeHandle,
    start_usn: i64,
    journal_id: u64,
) -> Result<UsnReadPage, ReplayError> {
    let bytes = read_usn_page(handle, start_usn, journal_id)?;
    Ok(parse_usn_page(&bytes)?)
}
