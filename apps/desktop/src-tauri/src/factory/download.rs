use reqwest::blocking::Client;
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri_plugin_dialog::DialogExt;

use super::{connection::Auth, public_status, route, transport_error};

pub(crate) fn suggested_name(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = leaf.chars().filter(|c| {
        !c.is_control() && !matches!(*c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    }).take(140).collect();
    let trimmed = clean.trim_matches([' ', '.']);
    let reserved = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    if trimmed.is_empty()
        || matches!(
            reserved.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
        || ["COM", "LPT"].iter().any(|prefix| {
            reserved.strip_prefix(prefix).is_some_and(|n| {
                ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&n)
            })
        })
    {
        return "工厂交付物".to_owned();
    }
    trimmed.to_owned()
}

const SAVE_FAILED: &str = "交付物未写入，请检查所选目录、磁盘空间和文件权限。";

// Keep an existing file intact until the entire authenticated response is durable.
fn write_to_destination(
    mut reader: impl Read,
    expected: Option<u64>,
    path: &Path,
) -> Result<(), String> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(SAVE_FAILED.to_owned());
    }
    let parent = path.parent().ok_or(SAVE_FAILED)?;
    let mut pending = tempfile::NamedTempFile::new_in(parent).map_err(|_| SAVE_FAILED)?;
    let size = io::copy(&mut reader, &mut pending).map_err(|_| "下载中断，原文件已保留。")?;
    if expected.is_some_and(|length| length != size) {
        return Err("下载内容不完整，请重新下载。".to_owned());
    }
    pending
        .flush()
        .and_then(|_| pending.as_file().sync_all())
        .map_err(|_| SAVE_FAILED)?;
    pending.persist(path).map_err(|_| SAVE_FAILED)?;
    Ok(())
}

fn choose_destination(app: &tauri::AppHandle, name: &str) -> Result<Option<PathBuf>, String> {
    let Some(location) = app
        .dialog()
        .file()
        .set_file_name(suggested_name(name))
        .blocking_save_file()
    else {
        return Ok(None);
    };
    location
        .into_path()
        .map(Some)
        .map_err(|_| SAVE_FAILED.to_owned())
}

pub(super) fn save_skill_file(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    if bytes.len() > 256 * 1024 {
        return Err("Skill 随包文件超过 256 KiB。".to_owned());
    }
    let Some(path) = choose_destination(&app, &name)? else {
        return Ok(false);
    };
    write_to_destination(bytes.as_slice(), Some(bytes.len() as u64), &path)?;
    Ok(true)
}

fn artifact_response(
    auth: Auth,
    route: &str,
    timeout: Duration,
) -> Result<reqwest::blocking::Response, String> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(6))
        .timeout(timeout)
        .build()
        .map_err(|_| SAVE_FAILED)?;
    let response = client
        .get(format!("{}{route}", auth.endpoint))
        .bearer_auth(auth.token)
        .send()
        .map_err(transport_error)?;
    public_status(response.status())?;
    Ok(response)
}

pub(super) fn preview_png(auth: Auth, task: &str, artifact: &str) -> Result<Vec<u8>, String> {
    const LIMIT: u64 = 32 * 1024 * 1024;
    const TOO_LARGE: &str = "图片较大，请下载原文件查看。";
    let route = route::artifact(task, artifact)?;
    let response = artifact_response(auth, &route, Duration::from_secs(45))?;
    if response.content_length().is_some_and(|size| size > LIMIT) {
        return Err(TOO_LARGE.into());
    }
    let mut bytes = Vec::new();
    response
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "图片读取中断，请重新预览。")?;
    if bytes.len() as u64 > LIMIT {
        return Err(TOO_LARGE.into());
    }
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("归档内容不是有效的 PNG 图片，可下载原文件核对。".into());
    }
    Ok(bytes)
}

pub(super) fn download(
    app: tauri::AppHandle,
    auth: Auth,
    task: String,
    artifact: String,
    name: String,
) -> Result<bool, String> {
    let route = route::artifact(&task, &artifact)?;
    let Some(path) = choose_destination(&app, &name)? else {
        return Ok(false);
    };
    let response = artifact_response(auth, &route, Duration::from_secs(600))?;
    let size = response.content_length();
    write_to_destination(response, size, &path)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_and_download_read_the_same_authenticated_archive() {
        use std::{
            io::{BufRead, BufReader},
            net::TcpListener,
            thread,
        };
        let png = include_bytes!("../../icons/128x128.png").as_slice();
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", server.local_addr().unwrap());
        let auth = || Auth {
            endpoint: endpoint.clone(),
            token: "test-only".into(),
        };
        let handle = thread::spawn(move || {
            for (response_type, body) in [
                ("image/png", png),
                ("image/png", png),
                ("text/html", b"<html>".as_slice()),
            ] {
                let (mut socket, _) = server.accept().unwrap();
                let mut request = String::new();
                let mut reader = BufReader::new(&socket);
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    request += &line;
                }
                assert!(request.starts_with("GET /v1/tasks/order/artifacts/painting HTTP/1.1"));
                assert!(
                    request
                        .to_lowercase()
                        .contains("authorization: bearer test-only\r\n")
                );
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: {response_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                socket.write_all(body).unwrap();
            }
        });
        assert!(preview_png(auth(), "order", "../painting").is_err());
        assert_eq!(preview_png(auth(), "order", "painting").unwrap(), png);
        let response = artifact_response(
            auth(),
            &route::artifact("order", "painting").unwrap(),
            Duration::from_secs(5),
        )
        .unwrap();
        let length = response.content_length();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("原图.png");
        write_to_destination(response, length, &path).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), png);
        assert!(
            preview_png(auth(), "order", "painting")
                .unwrap_err()
                .contains("有效的 PNG")
        );
        handle.join().unwrap();
    }

    #[test]
    fn only_a_safe_leaf_name_is_suggested_and_partial_download_does_not_replace_files() {
        assert_eq!(suggested_name(r"C:\drop\..\报告.pdf"), "报告.pdf");
        assert_eq!(suggested_name("x/CON.txt"), "工厂交付物");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("saved.bin");
        std::fs::write(&path, b"old").unwrap();
        assert!(write_to_destination(&b"xx"[..], Some(10), &path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        write_to_destination(&b"new-data"[..], Some(8), &path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new-data");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
