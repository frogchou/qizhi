#[cfg(windows)]
use crate::ntfs::{
    usn::{UsnParseError, UsnRecord, parse_usn_page},
    win32::{VolumeHandle, Win32Failure, enumerate_usn_page},
};

#[cfg(windows)]
#[derive(Debug)]
pub enum SnapshotError {
    Windows(Win32Failure),
    Parse(UsnParseError),
}

#[cfg(windows)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotPage {
    pub next_file_reference_number: u64,
    pub records: Vec<UsnRecord>,
}

#[cfg(windows)]
impl From<Win32Failure> for SnapshotError {
    fn from(value: Win32Failure) -> Self {
        Self::Windows(value)
    }
}

#[cfg(windows)]
impl From<UsnParseError> for SnapshotError {
    fn from(value: UsnParseError) -> Self {
        Self::Parse(value)
    }
}

#[cfg(windows)]
impl SnapshotError {
    pub fn is_end_of_enumeration(&self) -> bool {
        use windows_sys::Win32::Foundation::ERROR_HANDLE_EOF;

        matches!(
            self,
            Self::Windows(Win32Failure {
                code: ERROR_HANDLE_EOF,
                ..
            })
        )
    }
}

#[cfg(windows)]
pub fn read_snapshot_page(
    handle: &VolumeHandle,
    start_file_reference_number: u64,
    high_usn: i64,
) -> Result<SnapshotPage, SnapshotError> {
    let bytes = enumerate_usn_page(handle, start_file_reference_number, 0, high_usn)?;
    Ok(parse_snapshot_page(&bytes)?)
}

#[cfg(windows)]
pub fn parse_snapshot_page(bytes: &[u8]) -> Result<SnapshotPage, UsnParseError> {
    let next_file_reference_number = bytes
        .get(..8)
        .and_then(|value| value.try_into().ok())
        .map(u64::from_le_bytes)
        .ok_or(UsnParseError::MissingNextUsn)?;
    let parsed = parse_usn_page(bytes)?;
    Ok(SnapshotPage {
        next_file_reference_number,
        records: parsed.records,
    })
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn treats_handle_eof_as_the_normal_end_of_an_mft_enumeration() {
        use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_HANDLE_EOF};

        let eof = super::SnapshotError::Windows(crate::ntfs::win32::Win32Failure {
            operation: "enumerate NTFS metadata",
            code: ERROR_HANDLE_EOF,
        });
        let denied = super::SnapshotError::Windows(crate::ntfs::win32::Win32Failure {
            operation: "enumerate NTFS metadata",
            code: ERROR_ACCESS_DENIED,
        });

        assert!(eof.is_end_of_enumeration());
        assert!(!denied.is_end_of_enumeration());
    }
}
