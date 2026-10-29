use std::fmt;

pub const USN_REASON_DATA_OVERWRITE: u32 = 0x0000_0001;
pub const USN_REASON_FILE_CREATE: u32 = 0x0000_0100;
pub const USN_REASON_FILE_DELETE: u32 = 0x0000_0200;
pub const USN_REASON_RENAME_OLD_NAME: u32 = 0x0000_1000;
pub const USN_REASON_RENAME_NEW_NAME: u32 = 0x0000_2000;
pub const USN_REASON_BASIC_INFO_CHANGE: u32 = 0x0000_8000;
pub const USN_REASON_CLOSE: u32 = 0x8000_0000;

const PAGE_NEXT_USN_LENGTH: usize = 8;
const V2_MINIMUM_RECORD_LENGTH: usize = 60;
const V3_MINIMUM_RECORD_LENGTH: usize = 76;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsnReason(u32);

impl UsnReason {
    pub fn contains(self, reason: u32) -> bool {
        self.0 & reason != 0
    }

    pub fn bits(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsnRecord {
    pub major_version: u16,
    pub minor_version: u16,
    pub file_reference_number: String,
    pub parent_file_reference_number: String,
    pub usn: String,
    pub timestamp_filetime: i64,
    pub reasons: UsnReason,
    pub file_attributes: u32,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsnReadPage {
    pub next_usn: String,
    pub records: Vec<UsnRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UsnParseError {
    MissingNextUsn,
    TruncatedRecord,
    ZeroRecordLength,
    InvalidRecordLength,
    UnsupportedMajorVersion(u16),
    InvalidNameRange,
    InvalidUtf16Name,
}

impl fmt::Display for UsnParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingNextUsn => formatter.write_str("USN page is missing the next USN"),
            Self::TruncatedRecord => formatter.write_str("USN record is truncated"),
            Self::ZeroRecordLength => formatter.write_str("USN record length is zero"),
            Self::InvalidRecordLength => formatter.write_str("USN record length is invalid"),
            Self::UnsupportedMajorVersion(version) => {
                write!(formatter, "unsupported USN record major version {version}")
            }
            Self::InvalidNameRange => formatter.write_str("USN record file name range is invalid"),
            Self::InvalidUtf16Name => {
                formatter.write_str("USN record file name is not valid UTF-16")
            }
        }
    }
}

impl std::error::Error for UsnParseError {}

pub fn parse_usn_page(buffer: &[u8]) -> Result<UsnReadPage, UsnParseError> {
    let next_usn = read_i64(buffer, 0).ok_or(UsnParseError::MissingNextUsn)?;
    let mut offset = PAGE_NEXT_USN_LENGTH;
    let mut records = Vec::new();

    while offset < buffer.len() {
        let record_length =
            read_u32(buffer, offset).ok_or(UsnParseError::TruncatedRecord)? as usize;
        if record_length == 0 {
            return Err(UsnParseError::ZeroRecordLength);
        }
        let record_end = offset
            .checked_add(record_length)
            .ok_or(UsnParseError::InvalidRecordLength)?;
        if record_end > buffer.len() {
            return Err(UsnParseError::TruncatedRecord);
        }
        records.push(parse_record(&buffer[offset..record_end])?);
        offset = record_end;
    }

    Ok(UsnReadPage {
        next_usn: next_usn.to_string(),
        records,
    })
}

fn parse_record(record: &[u8]) -> Result<UsnRecord, UsnParseError> {
    let major_version = read_u16(record, 4).ok_or(UsnParseError::TruncatedRecord)?;
    let minor_version = read_u16(record, 6).ok_or(UsnParseError::TruncatedRecord)?;
    let (
        minimum_length,
        file_reference_number,
        parent_file_reference_number,
        usn_offset,
        timestamp_offset,
        reason_offset,
        attributes_offset,
        name_length_offset,
        name_offset_offset,
    ) = match major_version {
        2 => (
            V2_MINIMUM_RECORD_LENGTH,
            read_u64(record, 8)
                .ok_or(UsnParseError::TruncatedRecord)?
                .to_string(),
            read_u64(record, 16)
                .ok_or(UsnParseError::TruncatedRecord)?
                .to_string(),
            24,
            32,
            40,
            52,
            56,
            58,
        ),
        3 => (
            V3_MINIMUM_RECORD_LENGTH,
            format_reference_128(read_u128(record, 8).ok_or(UsnParseError::TruncatedRecord)?),
            format_reference_128(read_u128(record, 24).ok_or(UsnParseError::TruncatedRecord)?),
            40,
            48,
            56,
            68,
            72,
            74,
        ),
        version => return Err(UsnParseError::UnsupportedMajorVersion(version)),
    };

    if record.len() < minimum_length {
        return Err(UsnParseError::TruncatedRecord);
    }
    let name_length =
        read_u16(record, name_length_offset).ok_or(UsnParseError::TruncatedRecord)? as usize;
    let name_offset =
        read_u16(record, name_offset_offset).ok_or(UsnParseError::TruncatedRecord)? as usize;
    let name_end = name_offset
        .checked_add(name_length)
        .ok_or(UsnParseError::InvalidNameRange)?;
    if name_length % 2 != 0
        || name_offset < minimum_length
        || name_end > record.len()
        || name_end < name_offset
    {
        return Err(UsnParseError::InvalidNameRange);
    }

    let name = decode_utf16(&record[name_offset..name_end])?;
    Ok(UsnRecord {
        major_version,
        minor_version,
        file_reference_number,
        parent_file_reference_number,
        usn: read_i64(record, usn_offset)
            .ok_or(UsnParseError::TruncatedRecord)?
            .to_string(),
        timestamp_filetime: read_i64(record, timestamp_offset)
            .ok_or(UsnParseError::TruncatedRecord)?,
        reasons: UsnReason(read_u32(record, reason_offset).ok_or(UsnParseError::TruncatedRecord)?),
        file_attributes: read_u32(record, attributes_offset)
            .ok_or(UsnParseError::TruncatedRecord)?,
        name,
    })
}

fn decode_utf16(bytes: &[u8]) -> Result<String, UsnParseError> {
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
    String::from_utf16(&units.collect::<Vec<_>>()).map_err(|_| UsnParseError::InvalidUtf16Name)
}

fn format_reference_128(value: u128) -> String {
    format!("{value:032x}")
}

fn read_u16(buffer: &[u8], offset: usize) -> Option<u16> {
    let bytes: [u8; 2] = buffer
        .get(offset..offset.checked_add(2)?)?
        .try_into()
        .ok()?;
    Some(u16::from_le_bytes(bytes))
}

fn read_u32(buffer: &[u8], offset: usize) -> Option<u32> {
    let bytes: [u8; 4] = buffer
        .get(offset..offset.checked_add(4)?)?
        .try_into()
        .ok()?;
    Some(u32::from_le_bytes(bytes))
}

fn read_u64(buffer: &[u8], offset: usize) -> Option<u64> {
    let bytes: [u8; 8] = buffer
        .get(offset..offset.checked_add(8)?)?
        .try_into()
        .ok()?;
    Some(u64::from_le_bytes(bytes))
}

fn read_u128(buffer: &[u8], offset: usize) -> Option<u128> {
    let bytes: [u8; 16] = buffer
        .get(offset..offset.checked_add(16)?)?
        .try_into()
        .ok()?;
    Some(u128::from_le_bytes(bytes))
}

fn read_i64(buffer: &[u8], offset: usize) -> Option<i64> {
    let bytes: [u8; 8] = buffer
        .get(offset..offset.checked_add(8)?)?
        .try_into()
        .ok()?;
    Some(i64::from_le_bytes(bytes))
}
