use crate::ntfs::ipc::{
    INDEXER_PIPE_NAME, INDEXER_PROTOCOL_VERSION, IndexerRequest, IndexerRequestKind,
    IndexerResponse, MAX_IPC_MESSAGE_BYTES,
};

// `0x12019b` is the exact pipe-client access mask: read/write data, the
// associated metadata access and synchronize. It intentionally excludes
// `FILE_CREATE_PIPE_INSTANCE` (`0x4`), which generic write would grant.
// The service subsequently derives the caller SID from the connected pipe;
// request payloads never establish identity.
#[cfg(windows)]
const INDEXER_PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;AU)";

pub fn handle_request_bytes(message: &[u8]) -> Vec<u8> {
    let response = if message.len() > MAX_IPC_MESSAGE_BYTES {
        error_response(String::new(), "本地索引请求超过大小限制")
    } else {
        match serde_json::from_slice::<IndexerRequest>(message) {
            Ok(request) if request.protocol_version != INDEXER_PROTOCOL_VERSION => {
                error_response(request.request_id, "本地索引服务版本不兼容")
            }
            Ok(request) => match request.kind {
                IndexerRequestKind::Health => IndexerResponse {
                    protocol_version: INDEXER_PROTOCOL_VERSION,
                    request_id: request.request_id,
                    status: "ready".to_owned(),
                    message: None,
                    candidates: vec![],
                },
                IndexerRequestKind::Configure { .. }
                | IndexerRequestKind::Build
                | IndexerRequestKind::Sync
                | IndexerRequestKind::ListToday { .. } => {
                    error_response(request.request_id, "本地索引服务尚未完成授权配置")
                }
            },
            Err(_) => error_response(String::new(), "本地索引请求格式无效"),
        }
    };
    serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec())
}

#[cfg(windows)]
pub fn serve_health_pipe_until_stopped(
    stopped: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    serve_pipe_until_stopped(stopped, |_, message| handle_request_bytes(message))
}

#[cfg(windows)]
pub fn serve_controlled_pipe_until_stopped(
    stopped: &std::sync::atomic::AtomicBool,
    control: crate::ntfs::IndexerControlPlane,
) -> Result<(), String> {
    serve_pipe_until_stopped(stopped, move |caller_sid, message| {
        let response = match serde_json::from_slice::<IndexerRequest>(message) {
            Ok(request) => control.handle(caller_sid, &request),
            Err(_) => error_response(String::new(), "本地索引请求格式无效"),
        };
        serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec())
    })
}

#[cfg(windows)]
fn serve_pipe_until_stopped(
    stopped: &std::sync::atomic::AtomicBool,
    handle_request: impl Fn(&str, &[u8]) -> Vec<u8>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE},
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::{FILE_FLAGS_AND_ATTRIBUTES, PIPE_ACCESS_DUPLEX, ReadFile, WriteFile},
        System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_MESSAGE,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_WAIT,
        },
    };

    while !stopped.load(Ordering::SeqCst) {
        let mut descriptor = std::ptr::null_mut();
        let mut descriptor_size = 0_u32;
        let mut sddl = INDEXER_PIPE_SDDL
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let created = unsafe {
            // The descriptor keeps the pipe local and prevents clients from creating instances.
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_mut_ptr(),
                1,
                &mut descriptor,
                &mut descriptor_size,
            )
        };
        if created == 0 {
            return Err(last_pipe_error("无法创建本地索引服务安全描述符"));
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let mut name = INDEXER_PIPE_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_mut_ptr(),
                PIPE_ACCESS_DUPLEX as FILE_FLAGS_AND_ATTRIBUTES,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                MAX_IPC_MESSAGE_BYTES as u32,
                MAX_IPC_MESSAGE_BYTES as u32,
                1_000,
                &attributes,
            )
        };
        unsafe {
            let _ = windows_sys::Win32::Foundation::LocalFree(descriptor);
        }
        if handle == INVALID_HANDLE_VALUE {
            return Err(last_pipe_error("无法创建本地索引服务管道"));
        }
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
        if connected == 0 && unsafe { GetLastError() } != 535 {
            unsafe {
                let _ = CloseHandle(handle);
            }
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            return Err(last_pipe_error("本地索引服务管道连接失败"));
        }
        let mut input = vec![0_u8; MAX_IPC_MESSAGE_BYTES];
        let mut read = 0_u32;
        let received = unsafe {
            ReadFile(
                handle,
                input.as_mut_ptr(),
                input.len() as u32,
                &mut read,
                std::ptr::null_mut(),
            )
        };
        if received != 0 {
            let output = match authenticated_client_sid(handle) {
                Ok(caller_sid) => handle_request(&caller_sid, &input[..read as usize]),
                Err(message) => serde_json::to_vec(&error_response(String::new(), &message))
                    .unwrap_or_else(|_| b"{}".to_vec()),
            };
            let mut written = 0_u32;
            unsafe {
                let _ = WriteFile(
                    handle,
                    output.as_ptr(),
                    output.len() as u32,
                    &mut written,
                    std::ptr::null_mut(),
                );
            }
        }
        unsafe {
            let _ = DisconnectNamedPipe(handle);
            let _ = CloseHandle(handle);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn authenticated_client_sid(
    pipe: windows_sys::Win32::Foundation::HANDLE,
) -> Result<String, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, GetLastError, LocalFree},
        Security::Authorization::ConvertSidToStringSidW,
        Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser},
        System::{
            Pipes::GetNamedPipeClientProcessId,
            Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };

    let mut process_id = 0_u32;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut process_id) } == 0 || process_id == 0 {
        return Err(last_pipe_error("无法确认本地索引服务调用方"));
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return Err(last_pipe_error("无法打开本地索引服务调用方"));
    }
    let mut token = std::ptr::null_mut();
    let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) };
    unsafe {
        let _ = CloseHandle(process);
    }
    if opened == 0 {
        return Err(last_pipe_error("无法验证本地索引服务调用方"));
    }
    let mut required = 0_u32;
    let first =
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required) };
    if first != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || required == 0 {
        unsafe {
            let _ = CloseHandle(token);
        }
        return Err(last_pipe_error("无法读取本地索引服务调用方身份"));
    }
    let mut buffer = vec![0_u8; required as usize];
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    };
    unsafe {
        let _ = CloseHandle(token);
    }
    if read == 0 {
        return Err(last_pipe_error("无法读取本地索引服务调用方身份"));
    }
    let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut sid_text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut sid_text) } == 0 || sid_text.is_null() {
        return Err(last_pipe_error("无法验证本地索引服务调用方身份"));
    }
    let length = unsafe {
        (0..)
            .take_while(|&offset| *sid_text.add(offset) != 0)
            .count()
    };
    let result = String::from_utf16(unsafe { std::slice::from_raw_parts(sid_text, length) })
        .map_err(|_| "本地索引服务调用方身份无效".to_owned());
    unsafe {
        let _ = LocalFree(sid_text.cast());
    }
    match result {
        Ok(sid) if !sid.is_empty() => Ok(sid),
        Ok(_) => Err("本地索引服务调用方身份无效".to_owned()),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn last_pipe_error(action: &str) -> String {
    use windows_sys::Win32::Foundation::GetLastError;
    format!("{action}（Windows 错误 {}）", unsafe { GetLastError() })
}

fn error_response(request_id: String, message: &str) -> IndexerResponse {
    IndexerResponse {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id,
        status: "rejected".to_owned(),
        message: Some(message.to_owned()),
        candidates: vec![],
    }
}

#[cfg(windows)]
pub fn call_indexer_service(request: &IndexerRequest) -> Result<IndexerResponse, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_READ_DATA, FILE_WRITE_DATA, OPEN_EXISTING,
            ReadFile, SYNCHRONIZE, WriteFile,
        },
    };

    let encoded = serde_json::to_vec(request).map_err(|_| "本地索引请求无法编码".to_owned())?;
    if encoded.len() > MAX_IPC_MESSAGE_BYTES {
        return Err("本地索引请求超过大小限制".to_owned());
    }
    let pipe_name = INDEXER_PIPE_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let access = FILE_READ_DATA | FILE_WRITE_DATA | SYNCHRONIZE;
    let mut last_connect_error = 0_u32;
    let mut handle = INVALID_HANDLE_VALUE;
    for attempt in 0..60 {
        handle = unsafe {
            // Explicit rights avoid FILE_APPEND_DATA/FILE_CREATE_PIPE_INSTANCE implied by GENERIC_WRITE.
            CreateFileW(
                pipe_name.as_ptr(),
                access,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            break;
        }
        last_connect_error = unsafe { GetLastError() };
        if !is_retryable_pipe_connect_error(last_connect_error) || attempt == 59 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "本地索引服务不可用（Windows 错误 {}）",
            last_connect_error
        ));
    }
    let mut written = 0_u32;
    let wrote = unsafe {
        WriteFile(
            handle,
            encoded.as_ptr(),
            encoded.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        )
    };
    if wrote == 0 || written != encoded.len() as u32 {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err(format!(
            "无法向本地索引服务发送请求（Windows 错误 {}）",
            unsafe { GetLastError() }
        ));
    }
    let mut response = vec![0_u8; MAX_IPC_MESSAGE_BYTES];
    let mut read = 0_u32;
    let received = unsafe {
        ReadFile(
            handle,
            response.as_mut_ptr().cast(),
            response.len() as u32,
            &mut read,
            std::ptr::null_mut(),
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    if received == 0 {
        return Err(format!(
            "本地索引服务不可用（Windows 错误 {}）",
            unsafe { GetLastError() }
        ));
    }
    serde_json::from_slice(&response[..read as usize])
        .map_err(|_| "本地索引服务返回了无效数据".to_owned())
}

#[cfg(windows)]
fn is_retryable_pipe_connect_error(error: u32) -> bool {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY};
    matches!(error, ERROR_FILE_NOT_FOUND | ERROR_PIPE_BUSY)
}

#[cfg(not(windows))]
pub fn call_indexer_service(_: &IndexerRequest) -> Result<IndexerResponse, String> {
    Err("本地索引服务仅支持 Windows".to_owned())
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn pipe_acl_grants_only_the_documented_client_rights() {
        assert!(super::INDEXER_PIPE_SDDL.contains("0x12019b;;;AU"));
        assert!(!super::INDEXER_PIPE_SDDL.contains("GA;;;AU"));
    }

    #[cfg(windows)]
    #[test]
    fn retries_only_when_the_next_pipe_instance_is_temporarily_unavailable() {
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY,
        };

        assert!(super::is_retryable_pipe_connect_error(ERROR_FILE_NOT_FOUND));
        assert!(super::is_retryable_pipe_connect_error(ERROR_PIPE_BUSY));
        assert!(!super::is_retryable_pipe_connect_error(ERROR_ACCESS_DENIED));
    }
}
