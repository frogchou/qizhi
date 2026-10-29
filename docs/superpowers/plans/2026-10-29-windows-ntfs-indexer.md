# Windows NTFS/USN 索引器实施计划

> **For Codex:** Required execution skill: use superpowers:executing-plans to implement this plan task by task.

**目标：** 将“今日”页的递归目录扫描替换为栖知内置的、无 Everything 依赖的 Windows NTFS/USN 元数据索引器；初次建库由用户显式发起，之后刷新仅回放 USN 变更。

**架构：** 用一个 `ntfs` 领域模块隔离 Windows API 与不安全代码。该模块将卷资格、USN 缓冲区解析、初始快照和增量回放映射到 SQLite 仓储。`TodayIndexService` 使用保存的扫描规则决定相关卷、同步索引，再从索引事件查询今天的可展示文件。前端只显示索引状态，不再显示“已检查文件夹”。

**技术栈：** Rust 2024、Tauri 2、`windows-sys`、`rusqlite`、React/TypeScript、Vitest。

---

## 全局约束

- 不使用 PowerShell、`fsutil.exe`、`es.exe`、Everything DLL 或外部服务执行索引。
- 只允许 `src/ntfs/win32.rs` 出现 Windows 句柄和 `unsafe`；每个 Windows 调用都要包装为可诊断错误。
- Windows 不可用、非 NTFS、可移动卷、网络卷或 USN 不可读时，返回明确状态；绝不退回 `read_dir` 递归扫描。
- 文件发现不读取正文、不上传内容、不调用模型；日志不得写文件内容、密钥或完整用户路径。
- 每个数据库检查点与该页的条目/事件更新必须处于同一事务，失败时检查点不得前进。
- `ScanPolicy` 和 `FileTypeFilter` 是今天页可见性的最终裁决；索引本身不得绕开它们。

## 任务 1：建立数据库迁移与 NTFS 领域数据模型

**文件：**

- 修改：`apps/desktop/src-tauri/src/database/migrations.rs`
- 新建：`apps/desktop/src-tauri/migrations/0002_ntfs_index.sql`
- 新建：`apps/desktop/src-tauri/src/ntfs/mod.rs`
- 新建：`apps/desktop/src-tauri/src/ntfs/model.rs`
- 新建：`apps/desktop/src-tauri/src/ntfs/repository.rs`
- 修改：`apps/desktop/src-tauri/src/database/mod.rs`

**步骤：**

1. 先为迁移版本、卷状态枚举、检查点持久化、事件查询写失败测试，覆盖新数据库和已经在 v1 的数据库。
2. 创建 `0002_ntfs_index.sql`：`ntfs_volumes`、`ntfs_entries`、`ntfs_checkpoints`、`discovered_file_events` 及主键、外键和今天时间范围索引。
3. 将迁移框架从硬编码 v1 改为按版本顺序执行，保证已应用迁移可重复运行。
4. 定义不含 Win32 类型的领域模型：`IndexedVolume`、`VolumeState`、`UsnCheckpoint`、`IndexEntry`、`DiscoveredEvent`、`IndexDiagnostic`。
5. 实现 `NtfsIndexRepository`：卷 upsert、构建期 staging/切换、页级原子应用、检查点读写、事件按日期读取、卷状态读取。
6. 运行 Rust 单测，确认数据库升级和事务回滚。

**验收：** 空库升级到 schema v2；再次打开不重复执行；模拟写入失败后条目和 next-USN 都未改变。

## 任务 2：实现纯 Rust USN 记录解析器

**文件：**

- 新建：`apps/desktop/src-tauri/src/ntfs/usn.rs`

**步骤：**

1. 先写字节数组测试：输出缓冲区的 next-USN 前缀、V2 记录、V3 记录、中文 UTF-16 名称、零长度/截断记录、未知 major version、非法 name 偏移与 record length。
2. 定义独立于 FFI 的 `UsnRecord`、`UsnReason`、`UsnReadPage` 与 `UsnParseError`。
3. 以 little-endian 的显式读取函数解析可变长度记录，所有 offset/length 使用 checked arithmetic。
4. 对 V2（64 位 FRN）和 V3（128 位 FRN）作兼容表示；首期 NTFS 持久化为规范化文本 FRN，未知 major version 返回不可恢复错误。
5. 添加原因位的命名常量，并对 close/rename/delete/data/basic-info 进行单元测试。

**验收：** 解析器无 FFI、可在非 Windows 运行；任意畸形缓冲区不会 panic 或越界。

## 任务 3：实现最小 Windows 卷与 USN API 适配层

**文件：**

- 修改：`apps/desktop/src-tauri/Cargo.toml`
- 新建：`apps/desktop/src-tauri/src/ntfs/win32.rs`
- 新建：`apps/desktop/src-tauri/src/ntfs/volume.rs`
- 新建：`apps/desktop/src-tauri/src/ntfs/snapshot.rs`
- 新建：`apps/desktop/src-tauri/src/ntfs/replay.rs`

**步骤：**

1. 先写平台无关的卷路径规范化与资格决策测试：盘符根、UNC、可移动/网络/非 NTFS、不支持平台。
2. 增加精确的 `windows-sys` feature；仅暴露所需 FileSystem/Foundation/System IO 项，避免引入命令行依赖。
3. 在 `win32.rs` 中封装 RAII 卷句柄、`CreateFileW`、`DeviceIoControl`、`GetVolumeInformationW`、驱动器类型检查和 Win32 错误转换。所有 `unsafe` 块逐一说明内存/句柄不变式。
4. 使用 `FSCTL_QUERY_USN_JOURNAL` 获取当前 journal metadata；按文档填充 `MFT_ENUM_DATA`、`READ_USN_JOURNAL_DATA` 并调用 `FSCTL_ENUM_USN_DATA` / `FSCTL_READ_USN_JOURNAL`。
5. 将 API 输出转换成任务 2 的 `UsnReadPage`，适配层不连接 SQLite。
6. 在 Windows 上增加只读 smoke test（由环境变量启用）验证可打开测试卷、查询 journal；默认 CI 仅跑纯逻辑测试。

**验收：** 非 Windows 返回 `unsupported` 并通过编译；Windows 上所有 volume errors 带 Win32 错误码和恢复语义；没有进程启动或隐藏控制台窗口。

## 任务 4：实现索引器状态机、快照与增量回放

**文件：**

- 新建：`apps/desktop/src-tauri/src/ntfs/indexer.rs`
- 新建：`apps/desktop/src-tauri/src/ntfs/service.rs`
- 修改：`apps/desktop/src-tauri/src/telemetry/mod.rs`（仅当现有 logger 缺少结构化字段时）
- 新建：`apps/desktop/src-tauri/src/ntfs/indexer_tests.rs` 或模块内测试

**步骤：**

1. 先以 fake volume adapter 和临时 SQLite 编写状态机测试：首次建库、无变化回放、创建/编辑、重命名、删除、journal ID 变化、检查点过期、单卷失败与重试。
2. 定义 `UsnVolumeSource` port，让 `NtfsIndexer` 依赖 port，生产实现由任务 3 提供，测试实现为内存脚本。
3. 实现首次快照：记录开始 journal、将卷标为 `building`、分页写入 staging 条目、回放开始点之后的事件、原子发布为 `ready`。
4. 实现增量回放：检查 journal ID 和记录版本，每页事务应用条目/候选事件/next-USN；读取至无变化为止。
5. 实现 rename/delete 墓碑与同一 FRN 事件合并。路径按 FRN 父链重建，并在循环、父目录缺失和重解析点处失败关闭。
6. 应用当前 `ScanPolicy` 和 `FileTypeFilter` 后才持久化候选事件；查询时再次应用，保证设置改动即时生效。
7. 添加 `IndexProgress`（`idle/building/syncing/ready/rebuild-required/...`，处理记录数、变更数、消息、受影响卷），并写入脱敏诊断日志。

**验收：** fake source 覆盖全部状态迁移；一次失败不会丢失或跳过 USN；连续空刷新只执行 read journal 且处理数为零。

## 任务 5：将“今日”命令切换到 NTFS 索引服务

**文件：**

- 修改：`apps/desktop/src-tauri/src/app_state.rs`
- 修改：`apps/desktop/src-tauri/src/lib.rs`
- 修改：`apps/desktop/src-tauri/src/commands/today.rs`
- 修改：`apps/desktop/src-tauri/src/commands/mod.rs`（如需）
- 修改：`apps/desktop/src-tauri/src/scan/progress.rs` 或新建 `ntfs/progress.rs`
- 修改/移除测试：`apps/desktop/src-tauri/src/discovery/native_fs.rs`、`apps/desktop/src-tauri/src/commands/today.rs`

**步骤：**

1. 先改写 `today` 命令测试，明确断言刷新不构造 `NativeFileDiscovery`，且 Everything 缺失不会使索引失败。
2. 在应用启动时构造并管理 `NtfsIndexService`；只初始化依赖，不自动建库。
3. 增加命令：获取索引状态、显式开始建库、同步今日索引、重建单卷索引；按 Tauri snake/camel 约定暴露。
4. 将 `refresh_today` 的含义改为：索引已就绪时回放 USN；未建库时返回可操作状态而非递归扫描。保留 `get_today_snapshot` 读取事件数据库。
5. 在查询层按照当日边界、`ScanPolicy`、`FileTypeFilter` 返回 `TodayFile`；不读取文件内容。
6. 保留旧 `file_records` 的读取兼容但不再写入，向前端标注来源；确认旧 `NativeFileDiscovery` 无运行时调用后移除或隔离为开发迁移工具。
7. 全量运行 Rust 测试。

**验收：** 点击刷新在 ready 卷上从日志同步；首次使用要求显式建库；没有 `read_dir` 遍历且不依赖 Everything。

## 任务 6：实现索引状态 UI 与“今日”交互迁移

**文件：**

- 修改：`apps/desktop/src/features/today/*`（按实际组件名定位）
- 修改：`apps/desktop/src/features/settings/*`（按实际组件名定位）
- 修改：`apps/desktop/src/lib/tauri.ts` 或现有 IPC 契约文件
- 修改：相关 `*.test.tsx` / `*.test.ts`

**步骤：**

1. 先写组件测试：未建库时显示“建立本地索引”，building/syncing 时显示记录数而非文件夹数，unsupported 和 rebuild-required 提示清晰，ready 时刷新可用。
2. 替换所有“扫描”“已检查 N 个文件夹”的文案和轮询字段；UI 只消费新的索引状态。
3. 首次状态显示用户确认范围并提供“建立本地索引”；建库在后台运行，离开页面继续运行。
4. 在设置的扫描与隐私卡片加入按卷只读状态、最后同步、失败原因和“重建此卷索引”。
5. Everything 移到“可选兼容工具”，说明不影响今天页；不删除现有 DLL 资源，直到另一个发布任务决定是否移除。
6. 用现有视觉规范保持紧凑布局、内部列表滚动和长路径截断，避免重现横向滚动问题。
7. 运行前端单测、类型检查、lint、format 和 production build。

**验收：** 用户能理解首次索引和增量同步的区别；浏览今天页不会出现“已检查文件夹”或 PowerShell 窗口；小屏和长文件名没有横向溢出。

## 任务 7：集成验证、诊断和安装包交付

**文件：**

- 修改：`apps/desktop/README.md` 或适当用户文档
- 修改：`apps/desktop/src-tauri/tauri.conf.json`（仅当需要声明能力）
- 新建/修改：Windows 手工验收脚本或文档

**步骤：**

1. 增加脱敏日志事件的断言，确认日志没有完整路径和内容。
2. 在真实 NTFS 测试目录执行创建、修改、重命名、移动、删除；首次建库后验证今日列表和第二次同步。
3. 验证排除目录、文件分类、Everything 未运行、USN 不可用/失效模拟及单卷重建提示。
4. 执行所有后端和前端检查；使用离线锁定依赖构建 NSIS 安装包。
5. 检查安装包资源、首次启动、日志位置和无控制台窗口；记录版本、安装包路径、验证结果与已知限制。
6. 最终使用 verification-before-completion 复核后再报告完成。

**验收：** 可安装版本在 Everything 未安装的 Windows NTFS 机器上完成显式初次建库并通过增量同步验证；所有自动化检查通过。

## 建议验证命令

```powershell
$env:CARGO_HOME = 'C:\Users\fcc\.cargo'
$env:CARGO_NET_OFFLINE = 'true'
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline

apps/desktop/node_modules/.bin/vitest.cmd run
apps/desktop/node_modules/.bin/tsc.cmd --noEmit
apps/desktop/node_modules/.bin/eslint.cmd . --max-warnings=0
apps/desktop/node_modules/.bin/prettier.cmd --check .
apps/desktop/node_modules/.bin/vite.cmd build
```

## 代码审查重点

- 所有 USN 二进制缓冲区是否先验证边界、版本与长度再读取。
- 检查点是否绝不早于已提交数据库状态，journal reset 是否只重建对应卷。
- 是否真的取消了今天刷新路径中的递归 `read_dir` 及 Everything 依赖。
- 元数据、日志与 UI 是否始终尊重允许/排除范围和文件类型；没有内容读取。
- UI 是否正确区分“未建立”“同步中”“失败”和“没有今日文件”。
