# NTFS / USN Index

[中文](README.md) | [English](README_EN.md) | [Rust core](../../README_EN.md)

This module is Qizhi's local file-discovery engine and does not depend on Everything. It builds an initial snapshot from NTFS metadata, follows changes through the USN Journal, and communicates between the Windows service and desktop process.

Key areas include volume discovery, MFT/metadata snapshots, USN replay, the SQLite index repository, named-pipe IPC, service installation, and status control. This layer stores only required file metadata and does not read document bodies.
