# ADR 0001：采用 Tauri 2 作为 Windows 桌面壳

栖知采用 Tauri 2、React/TypeScript 和 Rust 本地服务层。界面不可直接访问磁盘、密钥或进程；Rust 层负责安全的文件发现、配置、凭据和系统集成。该选择优先满足小体积、本地优先与可替换适配器需求。
