use qizhi_desktop_lib::discovery::parse_es_output;

#[test]
fn parses_tabular_es_output_with_unicode_and_spaces() {
    let output = "D:\\工作资料\\周报 10月.docx\t1024\t1793189400000\nD:\\资料\\会议纪要.txt\t8\t1793189500000\n";

    let records = parse_es_output(output).expect("valid es output parses");

    assert_eq!(records.len(), 2);
    assert_eq!(records[0].path, r"D:\工作资料\周报 10月.docx");
    assert_eq!(records[1].size_bytes, 8);
}
