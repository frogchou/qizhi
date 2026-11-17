"""Bounded local text extraction. Never runs document macros or extracts ZIP paths."""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_UNPACKED = 80 * 1024 * 1024


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def xml(archive, name):
    data = archive.read(name)
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("XML entities/DTDs are unsupported")
    return ET.fromstring(data)


def paragraphs(root):
    return ["".join(element.itertext()) for element in root.iter() if local_name(element.tag) == "p"]


def extract(path, extension):
    if extension == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            raise ValueError("PDF extraction requires local pdftotext or pypdf")
        reader = PdfReader(path)
        if reader.is_encrypted:
            raise ValueError("encrypted PDF is unsupported")
        pages = [(index + 1, page.extract_text() or "") for index, page in enumerate(reader.pages)]
        return "\n\n".join(f"[Page {number}]\n{text}" for number, text in pages if text.strip())
    with zipfile.ZipFile(path) as archive:
        if sum(item.file_size for item in archive.infolist()) > MAX_UNPACKED:
            raise ValueError("document exceeds the 80 MiB unpacked-size limit")
        names = archive.namelist()
        if extension == ".docx":
            return "\n".join(paragraphs(xml(archive, "word/document.xml")))
        if extension == ".pptx":
            slides = sorted((name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)), key=lambda name: int(re.search(r"slide(\d+)", name).group(1)))
            slide_text = [(name, "\n".join(paragraphs(xml(archive, name)))) for name in slides]
            # A synthetic label is not readable document content; image-only slides cannot pass this check.
            return "\n\n".join(f"[{name}]\n{text}" for name, text in slide_text if text.strip())
        if extension == ".xlsx":
            shared = ["".join(item.itertext()) for item in xml(archive, "xl/sharedStrings.xml")] if "xl/sharedStrings.xml" in names else []
            sheets = sorted(name for name in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name))
            sections = []
            for name in sheets:
                lines = []
                for row in xml(archive, name).iter():
                    if local_name(row.tag) != "row":
                        continue
                    cells = []
                    for cell in row:
                        value = ""
                        if cell.attrib.get("t") == "inlineStr":
                            value = "".join(node.text or "" for node in cell.iter() if local_name(node.tag) == "t")
                        else:
                            value = next((node.text or "" for node in cell if local_name(node.tag) == "v"), "")
                            if cell.attrib.get("t") == "s" and value:
                                value = shared[int(value)]
                            formula = next((node.text or "" for node in cell if local_name(node.tag) == "f"), "")
                            if formula:
                                value = f"={formula}" + (f" [cached: {value}]" if value else "")
                        if value:
                            cells.append(f"{cell.attrib.get('r', '')}: {value}")
                    if cells:
                        lines.append(" | ".join(cells))
                if lines:
                    sections.append(f"[{name}]\n" + "\n".join(lines))
            return "\n\n".join(sections)
    raise ValueError("unsupported document format")


try:
    print(extract(sys.argv[1], sys.argv[2]), end="")
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
