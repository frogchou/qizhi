#[cfg(windows)]
use qizhi_desktop_lib::ntfs::snapshot::parse_snapshot_page;
use qizhi_desktop_lib::ntfs::usn::{
    USN_REASON_BASIC_INFO_CHANGE, USN_REASON_CLOSE, USN_REASON_DATA_OVERWRITE,
    USN_REASON_FILE_DELETE, USN_REASON_RENAME_NEW_NAME, UsnParseError, parse_usn_page,
};

fn push_u16(buffer: &mut Vec<u8>, value: u16) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(buffer: &mut Vec<u8>, value: u32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn push_i64(buffer: &mut Vec<u8>, value: i64) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn v2_record(name: &str, file_reference: u64, parent_reference: u64, reason: u32) -> Vec<u8> {
    let encoded_name = name
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let record_length = 60 + encoded_name.len();
    let mut record = Vec::with_capacity(record_length);
    push_u32(&mut record, record_length as u32);
    push_u16(&mut record, 2);
    push_u16(&mut record, 0);
    record.extend_from_slice(&file_reference.to_le_bytes());
    record.extend_from_slice(&parent_reference.to_le_bytes());
    push_i64(&mut record, 9001);
    push_i64(&mut record, 1_793_189_400_000_000_000);
    push_u32(&mut record, reason);
    push_u32(&mut record, 0);
    push_u32(&mut record, 0);
    push_u32(&mut record, 0x20);
    push_u16(&mut record, encoded_name.len() as u16);
    push_u16(&mut record, 60);
    record.extend_from_slice(&encoded_name);
    record
}

fn v3_record(name: &str, file_reference: u128, parent_reference: u128) -> Vec<u8> {
    let encoded_name = name
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let record_length = 76 + encoded_name.len();
    let mut record = Vec::with_capacity(record_length);
    push_u32(&mut record, record_length as u32);
    push_u16(&mut record, 3);
    push_u16(&mut record, 0);
    record.extend_from_slice(&file_reference.to_le_bytes());
    record.extend_from_slice(&parent_reference.to_le_bytes());
    push_i64(&mut record, 9002);
    push_i64(&mut record, 1_793_189_401_000_000_000);
    push_u32(&mut record, USN_REASON_RENAME_NEW_NAME);
    push_u32(&mut record, 0);
    push_u32(&mut record, 0);
    push_u32(&mut record, 0x10);
    push_u16(&mut record, encoded_name.len() as u16);
    push_u16(&mut record, 76);
    record.extend_from_slice(&encoded_name);
    record
}

#[test]
fn decodes_a_v2_page_with_next_usn_and_change_reasons() {
    let mut page = 9002_i64.to_le_bytes().to_vec();
    page.extend(v2_record(
        "weekly-report.docx",
        42,
        5,
        USN_REASON_DATA_OVERWRITE | USN_REASON_BASIC_INFO_CHANGE | USN_REASON_CLOSE,
    ));

    let parsed = parse_usn_page(&page).expect("page parses");

    assert_eq!(parsed.next_usn, "9002");
    assert_eq!(parsed.records.len(), 1);
    let record = &parsed.records[0];
    assert_eq!(record.file_reference_number, "42");
    assert_eq!(record.parent_file_reference_number, "5");
    assert_eq!(record.name, "weekly-report.docx");
    assert!(record.reasons.contains(USN_REASON_DATA_OVERWRITE));
    assert!(record.reasons.contains(USN_REASON_BASIC_INFO_CHANGE));
    assert!(record.reasons.contains(USN_REASON_CLOSE));
}

#[test]
fn decodes_a_v3_page_with_a_utf16_name_and_128_bit_references() {
    let mut page = 9003_i64.to_le_bytes().to_vec();
    page.extend(v3_record("会议纪要.md", 0x12, 0x34));

    let parsed = parse_usn_page(&page).expect("page parses");
    let record = &parsed.records[0];

    assert_eq!(record.name, "会议纪要.md");
    assert_eq!(
        record.file_reference_number,
        "00000000000000000000000000000012"
    );
    assert_eq!(
        record.parent_file_reference_number,
        "00000000000000000000000000000034"
    );
}

#[test]
fn rejects_truncated_and_unknown_usn_records_without_panicking() {
    let mut truncated = 9002_i64.to_le_bytes().to_vec();
    truncated.extend_from_slice(&[8, 0, 0, 0, 2, 0]);
    assert!(matches!(
        parse_usn_page(&truncated),
        Err(UsnParseError::TruncatedRecord)
    ));

    let mut unknown_version = 9002_i64.to_le_bytes().to_vec();
    let mut record = v2_record("notes.md", 1, 2, USN_REASON_FILE_DELETE);
    record[4] = 9;
    record[5] = 0;
    unknown_version.extend(record);
    assert!(matches!(
        parse_usn_page(&unknown_version),
        Err(UsnParseError::UnsupportedMajorVersion(9))
    ));
}

#[test]
fn rejects_a_record_with_a_name_outside_its_declared_length() {
    let mut page = 9002_i64.to_le_bytes().to_vec();
    let mut record = v2_record("notes.md", 1, 2, USN_REASON_FILE_DELETE);
    record[58] = 0xff;
    record[59] = 0x7f;
    page.extend(record);

    assert!(matches!(
        parse_usn_page(&page),
        Err(UsnParseError::InvalidNameRange)
    ));
}

#[cfg(windows)]
#[test]
fn decodes_an_mft_enumeration_cursor_as_a_file_reference_not_a_usn() {
    let mut page = 77_u64.to_le_bytes().to_vec();
    page.extend(v2_record("notes.md", 1, 2, USN_REASON_FILE_DELETE));

    let parsed = parse_snapshot_page(&page).expect("snapshot page parses");

    assert_eq!(parsed.next_file_reference_number, 77);
    assert_eq!(parsed.records[0].name, "notes.md");
}
