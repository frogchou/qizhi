# NTFS / USN 索引

[中文](README.md) | [English](README_EN.md) | [Rust 核心](../../README.md)

该模块是栖知的本地文件发现引擎，不依赖 Everything。它读取 NTFS 元数据建立初始快照，使用 USN Journal 增量同步变更，并通过 Windows 服务与桌面进程通信。

关键部分包括卷发现、MFT/元数据快照、USN 回放、SQLite 索引仓储、命名管道 IPC、服务安装与状态控制。索引只保存必要的文件元数据，不在此层读取文档正文。
