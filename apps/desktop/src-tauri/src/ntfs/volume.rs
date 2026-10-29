#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriveKind {
    Fixed,
    Network,
    Removable,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeProbe {
    pub mount_path: String,
    pub drive_kind: DriveKind,
    pub file_system: Option<String>,
    pub accessible: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VolumeQualification {
    Indexable,
    Unsupported(String),
    Unavailable(String),
}

pub fn qualify_volume(probe: &VolumeProbe) -> VolumeQualification {
    if !probe.accessible {
        return VolumeQualification::Unavailable("卷当前不可访问".to_owned());
    }
    if probe.drive_kind != DriveKind::Fixed {
        return VolumeQualification::Unsupported("仅支持固定本地磁盘".to_owned());
    }
    match probe.file_system.as_deref() {
        Some(value) if value.eq_ignore_ascii_case("NTFS") => VolumeQualification::Indexable,
        Some(value) => {
            VolumeQualification::Unsupported(format!("文件系统 {value} 不支持 NTFS 索引"))
        }
        None => VolumeQualification::Unavailable("无法读取卷文件系统信息".to_owned()),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QualifiedVolume {
    pub volume_guid: String,
    pub mount_path: String,
    pub serial_number: String,
    pub qualification: VolumeQualification,
}

#[cfg(windows)]
pub fn inspect_volume(mount_path: &str) -> QualifiedVolume {
    use windows_sys::Win32::{
        Storage::FileSystem::{
            GetDriveTypeW, GetVolumeInformationW, GetVolumeNameForVolumeMountPointW,
        },
        System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOTE, DRIVE_REMOVABLE},
    };

    let canonical_mount_path = normalize_mount_path(mount_path);
    let wide_path = wide_null(&canonical_mount_path);
    let drive_kind = match unsafe {
        // The string is explicitly NUL-terminated and lives through the call.
        GetDriveTypeW(wide_path.as_ptr())
    } {
        DRIVE_FIXED => DriveKind::Fixed,
        DRIVE_REMOTE => DriveKind::Network,
        DRIVE_REMOVABLE => DriveKind::Removable,
        _ => DriveKind::Other,
    };

    let mut serial_number = 0_u32;
    let mut file_system_buffer = [0_u16; 64];
    let accessible = unsafe {
        // All output buffers are valid and lengths are measured in UTF-16 code units.
        GetVolumeInformationW(
            wide_path.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial_number,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            file_system_buffer.as_mut_ptr(),
            file_system_buffer.len() as u32,
        ) != 0
    };
    let file_system = accessible.then(|| string_from_wide_null(&file_system_buffer));
    let qualification = qualify_volume(&VolumeProbe {
        mount_path: canonical_mount_path.clone(),
        drive_kind,
        file_system: file_system.clone(),
        accessible,
    });

    let mut volume_guid_buffer = [0_u16; 128];
    let has_guid = unsafe {
        // The mount path and fixed-size output buffer are both valid for this Win32 call.
        GetVolumeNameForVolumeMountPointW(
            wide_path.as_ptr(),
            volume_guid_buffer.as_mut_ptr(),
            volume_guid_buffer.len() as u32,
        ) != 0
    };

    QualifiedVolume {
        volume_guid: if has_guid {
            string_from_wide_null(&volume_guid_buffer)
        } else {
            canonical_mount_path.clone()
        },
        mount_path: canonical_mount_path,
        serial_number: if accessible {
            format!("{serial_number:08X}")
        } else {
            String::new()
        },
        qualification,
    }
}

#[cfg(not(windows))]
pub fn inspect_volume(mount_path: &str) -> QualifiedVolume {
    QualifiedVolume {
        volume_guid: mount_path.to_owned(),
        mount_path: mount_path.to_owned(),
        serial_number: String::new(),
        qualification: VolumeQualification::Unsupported("仅支持 Windows NTFS 卷".to_owned()),
    }
}

fn normalize_mount_path(value: &str) -> String {
    let normalized = value.replace('/', "\\");
    if normalized.len() == 2 && normalized.as_bytes()[1] == b':' {
        format!("{normalized}\\")
    } else {
        normalized
    }
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn string_from_wide_null(value: &[u16]) -> String {
    let length = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}
