use crate::ntfs::ipc::{
    INDEXER_PIPE_NAME, INDEXER_PROTOCOL_VERSION, IndexerRequest, IndexerRequestKind,
    IndexerResponse, MAX_IPC_MESSAGE_BYTES,
};

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
                },
                IndexerRequestKind::Build { .. } | IndexerRequestKind::Sync { .. } => {
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
        let mut sddl = "D:P(A;;GRGW;;;SY)(A;;GRGW;;;BA)(A;;GRGW;;;IU)"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let created = unsafe {
            // A protected DACL allows only LocalSystem, Administrators and interactive local users.
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
            let output = handle_request_bytes(&input[..read as usize]);
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
    }
}

#[cfg(windows)]
pub fn call_indexer_service(request: &IndexerRequest) -> Result<IndexerResponse, String> {
    use windows_sys::Win32::{Foundation::GetLastError, System::Pipes::CallNamedPipeW};

    let encoded = serde_json::to_vec(request).map_err(|_| "本地索引请求无法编码".to_owned())?;
    if encoded.len() > MAX_IPC_MESSAGE_BYTES {
        return Err("本地索引请求超过大小限制".to_owned());
    }
    let pipe_name = INDEXER_PIPE_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut response = vec![0_u8; MAX_IPC_MESSAGE_BYTES];
    let mut read = 0_u32;
    let success = unsafe {
        // The pipe name and buffers are valid for this synchronous call.
        CallNamedPipeW(
            pipe_name.as_ptr(),
            encoded.as_ptr().cast(),
            encoded.len() as u32,
            response.as_mut_ptr().cast(),
            response.len() as u32,
            &mut read,
            5_000,
        )
    };
    if success == 0 {
        return Err(format!(
            "本地索引服务不可用（Windows 错误 {}）",
            unsafe { GetLastError() }
        ));
    }
    serde_json::from_slice(&response[..read as usize])
        .map_err(|_| "本地索引服务返回了无效数据".to_owned())
}

#[cfg(not(windows))]
pub fn call_indexer_service(_: &IndexerRequest) -> Result<IndexerResponse, String> {
    Err("本地索引服务仅支持 Windows".to_owned())
}
