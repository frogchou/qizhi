use qizhi_desktop_lib::ntfs::volume::{
    DriveKind, VolumeProbe, VolumeQualification, qualify_volume,
};

#[test]
fn accepts_an_accessible_fixed_ntfs_volume() {
    let result = qualify_volume(&VolumeProbe {
        mount_path: r"D:\".to_owned(),
        drive_kind: DriveKind::Fixed,
        file_system: Some("NTFS".to_owned()),
        accessible: true,
    });

    assert_eq!(result, VolumeQualification::Indexable);
}

#[test]
fn rejects_network_removable_and_non_ntfs_volumes_without_a_filesystem_fallback() {
    for probe in [
        VolumeProbe {
            mount_path: r"\\server\share".to_owned(),
            drive_kind: DriveKind::Network,
            file_system: Some("NTFS".to_owned()),
            accessible: true,
        },
        VolumeProbe {
            mount_path: r"E:\".to_owned(),
            drive_kind: DriveKind::Removable,
            file_system: Some("NTFS".to_owned()),
            accessible: true,
        },
        VolumeProbe {
            mount_path: r"F:\".to_owned(),
            drive_kind: DriveKind::Fixed,
            file_system: Some("exFAT".to_owned()),
            accessible: true,
        },
    ] {
        assert!(matches!(
            qualify_volume(&probe),
            VolumeQualification::Unsupported(_)
        ));
    }
}
