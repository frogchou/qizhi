#[cfg(windows)]
use std::{
    ffi::c_void,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

#[cfg(windows)]
use crate::ntfs::pipe::serve_health_pipe_until_stopped;

pub const INDEXER_SERVICE_NAME: &str = "QizhiNtfsIndexer";

#[cfg(windows)]
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
pub fn handle_process_command() -> Result<bool, String> {
    let Some(command) = std::env::args().nth(1) else {
        return Ok(false);
    };
    match command.as_str() {
        "--ntfs-indexer-service" => {
            run_service_dispatcher()?;
            Ok(true)
        }
        "--install-ntfs-indexer-service" => {
            install_service()?;
            Ok(true)
        }
        "--uninstall-ntfs-indexer-service" => {
            uninstall_service()?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[cfg(not(windows))]
pub fn handle_process_command() -> Result<bool, String> {
    Ok(false)
}

#[cfg(windows)]
fn run_service_dispatcher() -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::GetLastError,
        System::Services::{SERVICE_TABLE_ENTRYW, StartServiceCtrlDispatcherW},
    };

    STOP_REQUESTED.store(false, Ordering::SeqCst);
    let mut name = wide(INDEXER_SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_mut_ptr(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW::default(),
    ];
    let success = unsafe {
        // The table and the service name remain alive until SCM returns from dispatching.
        StartServiceCtrlDispatcherW(table.as_ptr())
    };
    if success == 0 {
        return Err(format!(
            "Windows 服务调度器启动失败（错误 {}）",
            unsafe { GetLastError() }
        ));
    }
    Ok(())
}

#[cfg(windows)]
unsafe extern "system" fn service_main(_: u32, _: *mut *mut u16) {
    use windows_sys::Win32::System::Services::{RegisterServiceCtrlHandlerExW, SetServiceStatus};

    let mut name = wide(INDEXER_SERVICE_NAME);
    let status_handle = unsafe {
        // The service name is NUL-terminated and the handler stores no borrowed context.
        RegisterServiceCtrlHandlerExW(
            name.as_mut_ptr(),
            Some(service_control_handler),
            std::ptr::null(),
        )
    };
    if status_handle.is_null() {
        return;
    }
    set_status(status_handle, 4, 1);
    let pipe_stop = &STOP_REQUESTED;
    thread::spawn(move || {
        let _ = serve_health_pipe_until_stopped(pipe_stop);
    });
    while !STOP_REQUESTED.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(200));
    }
    set_status(status_handle, 3, 0);
    unsafe {
        // SCM owns the status handle; this final transition tells it the process can exit.
        SetServiceStatus(status_handle, &stopped_status());
    }
}

#[cfg(windows)]
unsafe extern "system" fn service_control_handler(
    control: u32,
    _: u32,
    _: *mut c_void,
    _: *mut c_void,
) -> u32 {
    if control == 1 {
        STOP_REQUESTED.store(true, Ordering::SeqCst);
    }
    0
}

#[cfg(windows)]
fn set_status(handle: *mut c_void, state: u32, controls: u32) {
    use windows_sys::Win32::System::Services::{
        SERVICE_STATUS, SERVICE_WIN32_OWN_PROCESS, SetServiceStatus,
    };

    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: controls,
        ..Default::default()
    };
    unsafe {
        // `status` is consumed synchronously by the SCM call.
        let _ = SetServiceStatus(handle, &status);
    }
}

#[cfg(windows)]
fn stopped_status() -> windows_sys::Win32::System::Services::SERVICE_STATUS {
    use windows_sys::Win32::System::Services::{SERVICE_STATUS, SERVICE_WIN32_OWN_PROCESS};

    SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: 1,
        ..Default::default()
    }
}

#[cfg(windows)]
fn install_service() -> Result<(), String> {
    use windows_sys::Win32::System::Services::{
        ChangeServiceConfig2W, ChangeServiceConfigW, CloseServiceHandle, CreateServiceW,
        OpenSCManagerW, OpenServiceW, SC_MANAGER_CONNECT, SC_MANAGER_CREATE_SERVICE, SERVICE_ALL_ACCESS,
        SERVICE_CONFIG_SERVICE_SID_INFO, SERVICE_DEMAND_START, SERVICE_ERROR_NORMAL,
        SERVICE_SID_INFO, SERVICE_SID_TYPE_UNRESTRICTED, SERVICE_WIN32_OWN_PROCESS, StartServiceW,
    };

    let manager = unsafe {
        // Local SCM with the minimum right needed to create this service.
        OpenSCManagerW(
            std::ptr::null(),
            std::ptr::null(),
            SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE,
        )
    };
    if manager.is_null() {
        return Err(last_error("无法打开 Windows 服务管理器"));
    }
    let service_path = format!("\"{}\" --ntfs-indexer-service", executable_path()?);
    let mut service_name = wide(INDEXER_SERVICE_NAME);
    let mut display_name = wide("栖知本地 NTFS 索引服务");
    let mut binary_path = wide(&service_path);
    let mut service = unsafe {
        CreateServiceW(
            manager,
            service_name.as_mut_ptr(),
            display_name.as_mut_ptr(),
            SERVICE_ALL_ACCESS,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_DEMAND_START,
            SERVICE_ERROR_NORMAL,
            binary_path.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if service.is_null() {
        service = unsafe { OpenServiceW(manager, service_name.as_mut_ptr(), SERVICE_ALL_ACCESS) };
        if service.is_null() {
            unsafe {
                let _ = CloseServiceHandle(manager);
            }
            return Err(last_error("无法创建本地索引服务"));
        }
        let updated = unsafe {
            ChangeServiceConfigW(
                service,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_DEMAND_START,
                SERVICE_ERROR_NORMAL,
                binary_path.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                display_name.as_mut_ptr(),
            )
        };
        if updated == 0 {
            unsafe {
                let _ = CloseServiceHandle(service);
                let _ = CloseServiceHandle(manager);
            }
            return Err(last_error("无法更新本地索引服务"));
        }
    }
    let sid_info = SERVICE_SID_INFO {
        dwServiceSidType: SERVICE_SID_TYPE_UNRESTRICTED,
    };
    let configured = unsafe {
        ChangeServiceConfig2W(
            service,
            SERVICE_CONFIG_SERVICE_SID_INFO,
            (&sid_info as *const SERVICE_SID_INFO).cast(),
        )
    };
    if configured == 0 {
        unsafe {
            let _ = CloseServiceHandle(service);
            let _ = CloseServiceHandle(manager);
        }
        return Err(last_error("无法配置本地索引服务身份"));
    }
    let started = unsafe { StartServiceW(service, 0, std::ptr::null()) };
    let start_error = (started == 0).then(|| unsafe { windows_sys::Win32::Foundation::GetLastError() });
    unsafe {
        let _ = CloseServiceHandle(service);
        let _ = CloseServiceHandle(manager);
    }
    if let Some(error) = start_error.filter(|error| *error != 1_056) {
        return Err(format!("无法启动本地索引服务（Windows 错误 {error}）"));
    }
    Ok(())
}

#[cfg(windows)]
fn uninstall_service() -> Result<(), String> {
    use windows_sys::Win32::System::Services::{
        CloseServiceHandle, ControlService, DeleteService, OpenSCManagerW, OpenServiceW,
        SC_MANAGER_CONNECT, SERVICE_ALL_ACCESS, SERVICE_STATUS,
    };

    let manager = unsafe {
        OpenSCManagerW(
            std::ptr::null(),
            std::ptr::null(),
            SC_MANAGER_CONNECT,
        )
    };
    if manager.is_null() {
        return Ok(());
    }
    let mut name = wide(INDEXER_SERVICE_NAME);
    let service = unsafe { OpenServiceW(manager, name.as_mut_ptr(), SERVICE_ALL_ACCESS) };
    if !service.is_null() {
        let mut status = SERVICE_STATUS::default();
        unsafe {
            let _ = ControlService(service, 1, &mut status);
            let _ = DeleteService(service);
            let _ = CloseServiceHandle(service);
        }
    }
    unsafe {
        let _ = CloseServiceHandle(manager);
    }
    Ok(())
}

#[cfg(windows)]
fn executable_path() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|_| "无法定位栖知程序文件".to_owned())
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn last_error(action: &str) -> String {
    use windows_sys::Win32::Foundation::GetLastError;
    format!("{action}（Windows 错误 {}）", unsafe { GetLastError() })
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
