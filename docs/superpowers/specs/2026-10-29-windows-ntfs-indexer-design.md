# 栖知内置 Windows NTFS 索引器设计

**状态：待审批**  
**日期：2026-10-29**  
**范围：阶段 0–1 的本地文件发现基础设施替换**

## 1. 意图

栖知的“今日”页应当快速、稳定地发现用户允许范围内当天发生变化的工作文件，而不要求安装或启动 Everything，也不能在每次刷新时递归遍历目录树。

现有 `NativeFileDiscovery` 从用户允许目录开始逐层调用 `read_dir`。这会随着目录数量线性变慢，进度中的“已检查文件夹”就是实际访问的目录数；它不符合“本地索引、增量发现”的产品承诺。

本设计将文件发现重构为 Windows 专属的 NTFS 索引器：首次为每个本地 NTFS 卷建立元数据索引，之后依据该卷的 USN 变更日志增量维护。`今天` 页读取本地 SQLite 索引，而不是扫描目录或请求 Everything。

## 2. 目标

1. 默认路径不依赖 Everything、`es.exe` 或常驻的第三方服务。
2. 已建立索引的 NTFS 卷中，常规“刷新列表”只消化自上次检查点以来的变更；不进行递归目录遍历。
3. 初始建库也不对每个文件调用 Rust 标准库目录遍历，而是通过 NTFS 的 USN/MFT 元数据枚举建立文件树。
4. 对允许扫描目录、排除目录、文件类型三个现有规则保持严格一致；规则修改后，列表查询立即生效。
5. 文件发现阶段仅处理元数据：卷、文件标识、父标识、名称、属性、大小、修改时间、USN；不读取文件内容、不上传文件、不调用模型。
6. 日志被删除、截断、卷更换、索引损坏等情况可诊断、可恢复，并且只重建受影响的卷。
7. 让用户和日志都能明确区分“首次建立索引”“正在同步变更”“已就绪”“需要重建”“不支持的卷”，不再把索引过程描述成“扫描文件夹”。
8. 有可自动验证的 Windows API 解析、SQLite 迁移、增量回放、路径与隐私规则测试；非 Windows 平台可编译并明确返回“不支持”。

## 3. 非目标与反目标

### 非目标

- 首期不支持 FAT、exFAT、ReFS、网络共享、OneDrive 虚拟占位文件、可移动盘和 Linux/WSL 文件系统的索引。
- 首期不创建、修改或删除 Windows 的 USN 日志，也不要求管理员权限去创建日志。
- 首期不索引全文、不提取内容、不计算重复文件、不做价值判断；这些以后均消费本索引提供的候选文件。
- 首期不替代 Everything 的全盘名称搜索能力。Everything 保留为设置中的可选兼容状态检测，不能影响默认发现链路。
- 首期不在产品内开放任意 MFT/USN 原始数据，也不让前端直接访问卷设备句柄。

### 反目标

- **不能**在 USN 不可用时悄悄退回对全部允许目录的递归扫描；这会重新引入不可预测的卡顿和隐私风险。
- **不能**为了获得增量记录而将用户未允许目录中的文件暴露到“今日”页或遥测/日志中。
- **不能**将“索引尚未建立”伪装为“没有今日文件”。
- **不能**将第三方 Everything 服务变成隐藏的运行时前提。

## 4. 约束和前提

- 桌面端为 Tauri 2 / React，后端为 Rust，现有本地数据库为 bundled SQLite（`rusqlite`）。
- 首发运行环境是 Windows 原生桌面，索引器使用 Windows API，不通过 PowerShell、`fsutil.exe` 或其他命令行工具执行。
- 仅处理固定、可访问、NTFS 格式的本地卷。卷类型和文件系统必须在建库前检查；不满足条件的根路径会获得明确状态。
- 当前扫描规则是允许根目录、用户排除目录、文件类别（文档/源代码）。索引数据与“是否在 UI 中可见”分离，以确保目录改名、移动和删除仍可正确回放。
- Windows 的 USN 日志按卷保存。检查点必须至少绑定卷的稳定身份和 `UsnJournalID`，不能只按盘符保存。
- `USN_RECORD` 是变长且存在不同 major version 的结构；解析必须根据每条记录的 `RecordLength` 和版本字段进行运行时校验，未知主版本不能继续解析。

## 5. 考虑过的方案

### A. 自有 NTFS/USN + SQLite 层级索引（已选择）

使用卷句柄和 `DeviceIoControl` 调用 `FSCTL_QUERY_USN_JOURNAL`、`FSCTL_ENUM_USN_DATA` 和 `FSCTL_READ_USN_JOURNAL`。SQLite 保存文件引用号（FRN）、父 FRN、名称、必要元数据、卷检查点和可展示的事件。

优点：没有 Everything 依赖；常规同步只读变更日志；可处理重命名、移动、删除；后续可服务知识库候选、工作总结和 Codex 文件选择。  
代价：Windows API 边界、变长二进制记录、检查点与重建策略必须实现和测试完整。

### B. 递归扫描 + 时间戳缓存

实现较少，但每次刷新或缓存失效仍需访问大量目录，无法保证时间上界，也与产品方向冲突。

### C. Everything 作为默认适配器

可快速利用第三方索引，但必须依赖用户启动 Everything 服务，且无法控制其隐私/可用性边界。它不符合“栖知内置索引器”的目的。

**结论：采用 A。** Everything 仅可在未来作为显式可选的外部搜索增强，不影响索引器正确性和可用性。

## 6. 总体架构

```text
Windows NTFS 卷
  ├─ FSCTL_ENUM_USN_DATA ──────> 初始元数据快照
  └─ FSCTL_READ_USN_JOURNAL ──> 增量 USN 记录
                                      │
                                      ▼
                          NtfsIndexer（Rust 域服务）
                            ├─ 记录版本/边界校验
                            ├─ FRN 父子树维护
                            ├─ rename / delete 状态机
                            ├─ 单卷事务与检查点推进
                            └─ 诊断事件
                                      │
                                      ▼
                         SQLite 本地索引（内部数据层）
                            ├─ ntfs_volumes
                            ├─ ntfs_entries
                            ├─ ntfs_checkpoints
                            └─ discovered_file_events
                                      │
                                      ▼
              TodayQueryService + ScanPolicy + FileTypeFilter
                                      │
                                      ▼
                           “今日”列表 / 工作总结候选
```

`TodayQueryService` 是新发现边界。现有 `ScanService + NativeFileDiscovery` 只在迁移期间保留为旧代码，不能由新的“刷新列表”调用。

## 7. 数据模型

### 7.1 卷表 `ntfs_volumes`

每个已尝试索引的卷一行。

| 字段 | 说明 |
| --- | --- |
| `id` | 内部主键 |
| `volume_guid` | Windows 卷 GUID 路径；用于跨盘符重连 |
| `current_mount_path` | 当前显示盘符，例如 `D:\` |
| `serial_number` | 卷序列号，辅助诊断 |
| `file_system` | 必须为 `NTFS` 才可 `ready` |
| `state` | `ready` / `building` / `rebuild_required` / `unsupported` / `unavailable` / `failed` |
| `state_message` | 面向诊断的简短原因，不含密钥与文件内容 |
| `last_indexed_at_utc_ms` | 最后成功同步时间 |
| `last_error_at_utc_ms` | 最后失败时间 |

### 7.2 条目表 `ntfs_entries`

保存路径树还原所需的最小元数据。唯一键为 `(volume_id, file_reference_number)`。

| 字段 | 说明 |
| --- | --- |
| `volume_id` | 所属卷 |
| `file_reference_number` | NTFS FRN，以固定可比较文本或 64 位无符号值保存 |
| `parent_file_reference_number` | 父目录 FRN；根目录为 null/保留值 |
| `name` | 最后已知文件名 |
| `is_directory` | 是否目录 |
| `file_attributes` | 用于跳过目录/重解析点等 |
| `size_bytes` | 可用时的大小；未知为 null |
| `modified_at_utc_ms` | 可用时的最后修改时间 |
| `last_usn` | 最后应用的记录 USN |
| `deleted_at_utc_ms` | 删除墓碑时间；用于防止旧事件复活 |

不在这里存文件正文、哈希、模型分析结果或用户私密内容。

### 7.3 检查点表 `ntfs_checkpoints`

唯一键为 `volume_id`。字段包括 `usn_journal_id`、`next_usn`、`first_usn_seen`、`last_successful_sync_at_utc_ms`、`schema/record_major_version`。只有在同一 SQLite 事务中写完相关条目后才推进 `next_usn`。

### 7.4 可展示事件表 `discovered_file_events`

只记录经过当前扫描规则过滤后、可作为工作候选的文件事件。字段：`id`、`volume_id`、`file_reference_number`、`canonical_path`、`event_kind`、`modified_at_utc_ms`、`size_bytes`、`source`。

“今天”页只查这个表（再应用实时规则），不查询所有元数据条目。保留原因是今天查询无需在前端临时重建全部路径树，同时重命名/删除的诊断与历史更清晰。

## 8. Windows API 适配层

### 8.1 模块边界

新增 `src/ntfs/`，分为：

- `volume.rs`：枚举配置根涉及的本地卷；查询挂载点、卷 GUID、文件系统和访问状态。
- `win32.rs`：唯一允许 `unsafe` 的窄接口层；包装 `CreateFileW`、`DeviceIoControl`、`CloseHandle`、`GetVolumeInformationW` 等。
- `usn.rs`：纯 Rust 的缓冲区/USN 记录解码器和数据结构；不接触数据库。
- `snapshot.rs`：通过 `FSCTL_ENUM_USN_DATA` 分页接收元数据快照。
- `replay.rs`：通过 `FSCTL_READ_USN_JOURNAL` 读取从检查点开始的变更。
- `indexer.rs`：协调建库、事务回放、状态迁移和诊断。
- `repository.rs`：SQLite 仓储；所有 SQL 集中于此。
- `service.rs`：根据扫描规则选择相关卷、同步并提供“今日”候选查询。

Windows 结构与常量来自 `windows-sys` 的 `Win32_Storage_FileSystem` / `Win32_System_IO` 等功能。Windows 相关代码全部使用 `#[cfg(windows)]`；非 Windows 提供同名的不支持实现，保证开发工具链和测试可运行。

### 8.2 卷资格

对于每个允许根：

1. 标准化为可展示的绝对路径，不解析或跨越重解析点。
2. 获得所属本地卷与文件系统；同一卷的多个允许根合并为一次同步。
3. 仅 NTFS + 固定本地卷加入索引任务。
4. 未支持的根以卷状态呈现并写入诊断；不触发递归兜底扫描。

### 8.3 初始建库流程

1. 打开 `\\.\X:` 卷句柄，并查询当前 USN 日志元数据。
2. 在数据库中将该卷标为 `building`，保存本次开始时的 `UsnJournalID` 与起点 `NextUsn`。
3. 使用 `FSCTL_ENUM_USN_DATA` 从 `StartFileReferenceNumber = 0` 分页枚举，解析每条记录的 FRN、父 FRN、名称、属性和 USN，并批量写入 `ntfs_entries`。
4. 枚举完成后，读取在步骤 1 起点之后追加的变更记录并回放，消除初始快照和当前状态之间的竞态窗口。
5. 完成事务后写入检查点 `next_usn`，卷状态改为 `ready`。
6. 任一步失败时保留旧的完整索引（若存在）或标记 `failed/rebuild_required`；不得将半个新索引标为可用。

建立索引期仍需要枚举 NTFS 元数据，所以首次耗时与磁盘中文件数量相关；但它不是对用户目录逐层 `read_dir`。UI 应显示“正在建立本地索引（已处理 N 条文件记录）”，而不是“正在扫描 N 个文件夹”。

### 8.4 增量同步流程

1. 读取本地 `UsnJournalID` 和 `next_usn`。
2. 查询当前 USN 日志；若日志 ID 不匹配、检查点已被裁剪或系统报告 journal 删除/失效，则该卷进入 `rebuild_required`。
3. 用 `FSCTL_READ_USN_JOURNAL` 从 `next_usn` 分页读取记录；每页在一个 SQLite 事务中应用条目变更和候选事件。
4. 每页成功后保存返回的下一 USN；失败时检查点不前进，下次可安全重试。
5. 无新增记录时正常返回，今天页直接读取事件表。

常规 UI 刷新只执行这一步，读取量与“自上次同步后的改变数”相关，而不是磁盘目录总数。

### 8.5 USN 事件应用规则

- 创建、数据覆盖、数据扩展、基本信息变化、关闭：更新条目名称/父项/属性/USN，并在当前规则允许且扩展名受支持时写入或更新候选事件。
- 重命名：按 `RENAME_OLD_NAME` 与 `RENAME_NEW_NAME` 配对；配对不完整时以最新的 FRN、父 FRN、名称为准，并在日志留下可诊断的降级事件。
- 删除：在目录树中保留墓碑，以便删除后到达的旧记录不会错误复活；删除文件不进入“今日”工作文件候选。
- 目录变动：更新目录条目即可；路径在查询时按父 FRN 链重建或由受影响子项失效后重算。
- 重解析点、系统目录、排除目录和不支持扩展名：可保留最少的内部层级信息，但绝不写入 `discovered_file_events`。
- 同一文件在一次编辑中出现多条 USN 记录时，按 FRN 合并为最新的可展示状态，避免“今日”列表重复。

## 9. 路径、隐私与规则一致性

索引器必须维护比“今日”列表更完整的目录关系，才能正确解释移动和重命名；但展示和下游处理始终在查询边界执行现有 `ScanPolicy` 与 `FileTypeFilter`。

1. 允许根是展示的白名单：只有路径落在至少一个允许根下的普通文件才可能成为候选。
2. 系统锁定目录、`AppData`、网络 UNC、重解析路径及用户排除目录始终拒绝。
3. 扫描范围和文件类型保存后，“今日”查询立即重新应用规则，已存在的事件会被隐藏；无需等待重新建库。
4. 规则收窄时，后台任务清理不再可见的 `discovered_file_events`；底层 `ntfs_entries` 仅保留恢复层级所需的最少数据，并按保留期清理墓碑。
5. 日志只记录卷、计数、状态码和已脱敏的路径类别；不记录 API Key、文件内容或整条用户路径。

## 10. 前端与交互迁移

### 今日页

- 首次安装或某个卷需要重建时，栖知不会在应用启动后静默占用磁盘；用户在“今日”页点击“建立本地索引”后才开始。此动作只覆盖当时已保存的允许扫描范围，并可在后台继续，关闭页面不会中断。
- “刷新列表”改为“同步本地索引”；按钮在同步中禁用并可显示短状态。
- 状态文案：
  - `索引已就绪 · 已同步 X 项变更`
  - `正在建立本地索引 · 已处理 X 条文件记录`
  - `卷 D: 的索引需要重建`
  - `E: 不是 NTFS，未纳入本地索引`
- 移除“已检查 X 个文件夹”的计数。首次建库仅显示元数据记录处理数；常规同步显示变更记录数。
- 若可用索引尚未建立，不显示“没有文件”，而显示原因、受影响卷及“开始建立索引/稍后重试”动作。

### 设置页

- “扫描与隐私”保留允许范围、排除目录、文件类型；增加只读“本地索引状态”卡片，按卷展示文件系统、状态、最近同步和“重建此卷索引”。
- Everything 状态移至“可选兼容工具”，说明它不再影响“今日”发现。
- 不显示卷句柄、USN、FRN 等内部值；诊断日志可导出为脱敏文本。

## 11. 错误处理和可观测性

所有索引操作带 `correlation_id`，并写入现有 `AppLogger`：

- `ntfs-index/volume-qualified`
- `ntfs-index/bootstrap-started`
- `ntfs-index/bootstrap-completed`
- `ntfs-index/journal-replayed`
- `ntfs-index/journal-reset`
- `ntfs-index/unsupported-volume`
- `ntfs-index/api-failed`

每条日志包含卷标识（尽量为盘符/卷哈希）、阶段、持续时间、处理条数、Windows 错误码和恢复建议；不记录内容、密钥或完整文件名。UI 只展示对用户有行动意义的摘要，详细错误经日志查看。

错误策略：

| 情况 | 行为 |
| --- | --- |
| NTFS 卷暂时不可访问 | 标记 `unavailable`，保留旧事件并标注可能过期；下次同步重试 |
| 非 NTFS/网络/可移动卷 | `unsupported`，不做递归扫描 |
| 无 USN 日志或日志读取不可用 | `unavailable`，明确说明该卷无法使用内置索引；不创建日志 |
| 日志 ID 变化、检查点被裁剪 | `rebuild_required`，仅重建该卷 |
| 记录主版本未知/长度非法 | 停止该卷回放，保持检查点不前进，标记 `failed` |
| SQLite 写入失败 | 回滚该页，检查点不前进；可安全重试 |

## 12. 迁移、发布和回滚

1. 新增独立数据库迁移，不修改既有 `file_records` 语义。
2. 首发时保持旧 `file_records` 只读，用于避免升级瞬间使历史列表为空；“今日”查询优先新索引事件，旧记录仅在索引状态未就绪时以明确的“旧缓存”标识可选展示。
3. 新索引器通过功能开关 `native_ntfs_indexer` 发布，开发版和内部测试版先启用；生产默认启用前需要性能与恢复验收。
4. 若索引器出现系统性故障，关闭开关即可停止新同步并保留数据库；**不会**自动回到递归扫描。用户可手动使用旧的有限缓存，并看到明确状态。
5. 数据库升级采用前向迁移，升级前自动备份 SQLite；每次迁移附带回归测试。
6. 首次建库采用显式用户动作而非静默启动；已就绪的卷可在用户打开“今日”页或点击“同步本地索引”时自动进行轻量增量同步。

## 13. 测试与验收

### 自动化测试

- 纯 Rust 单元测试：USN V2/V3 缓冲区解析、长度边界、未知版本、UTF-16 文件名、分页 next-USN、重命名配对、删除墓碑、事件合并。
- SQLite 仓储测试：事务原子性、检查点仅在成功后推进、单卷重建不影响其他卷、规则变化立即隐藏历史事件。
- 服务测试：允许根/排除目录/扩展名/跨卷分组、非 NTFS 和无索引状态映射。
- Windows 集成测试（仅 Windows CI/测试机）：临时 NTFS 目录中创建、编辑、重命名、移动、删除文件，验证下一次同步返回正确的今日候选；使用真实卷句柄但不得创建/删除日志。
- 端到端 UI 测试：首次建库状态、常规同步状态、重建提示、今日筛选和排序。

### 性能验收

- 在已有索引的 NTFS 卷中，连续无变化的“同步本地索引”不得枚举目录；日志中应显示 `journal-replayed` 且处理数为 0。
- 单次少量文件变更后，同步所处理的 USN 记录数应与改变数量相近，不随用户目录总数增长。
- 首次建库期间 UI 保持可交互，状态至少每秒更新一次；不弹出 PowerShell 或命令行窗口。
- 扫描规则收窄后，排除目录和二进制文件必须在同一次查询中消失。

### 正确性验收

- 创建、修改、重命名、移动和删除不会让“今日”页出现错误路径或重复条目。
- USN journal ID 变化或被裁剪时，程序不静默遗漏事件，明确要求重建对应卷。
- Everything 未安装、未运行或 DLL 缺失时，索引器和今天页仍可工作。

## 14. 分阶段交付

### 里程碑 1：可用索引核心

卷资格检测、SQLite 迁移、USN 二进制解析器、单卷初次快照、检查点、增量回放、命令接口和基础状态页。此阶段替换“今日”刷新链路，但不修改知识库上传逻辑。

### 里程碑 2：稳健性和交互完善

完整的重命名/删除策略、单卷重建、日志导出、索引状态卡、保留期清理、Windows 集成测试和安装包验证。

### 里程碑 3：上层能力接入

基于索引事件提供文件价值筛选、用户确认后上传 RAGFlow、内容提取、工作总结以及 Codex @ 文件。它们不能绕开本索引的隐私规则。

## 15. 实现者待办与关键审查点

以下是实现过程中必须逐项验证的技术点，不能以猜测替代：

1. `windows-sys` 所需功能集合、结构布局和 x64 对齐；将所有 `unsafe` 集中于最小适配层。
2. 当前目标 Windows 版本上 `FSCTL_ENUM_USN_DATA` / `FSCTL_READ_USN_JOURNAL` 的真实权限和错误码行为。
3. 初始快照起点与增量回放的竞态处理，确保不会遗漏建库期间发生的改动。
4. FRN 表示、根目录定位、卷 GUID 与盘符变化的映射。
5. V2/V3/V4 USN 记录兼容策略；未知主版本必须失败关闭。
6. SQLite 数据规模、索引（尤其 `volume_id + parent_filereference`、今天事件时间范围）和墓碑保留期。
7. Windows CI 或专用测试机的真实 NTFS 集成测试环境。

## 16. 参考依据

- Microsoft 将 `FSCTL_ENUM_USN_DATA` 定义为枚举 MFT/USN 元数据记录的操作，并说明用 `FSCTL_READ_USN_JOURNAL` 识别近期改动：[FSCTL_ENUM_USN_DATA](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_enum_usn_data)。
- USN 记录提供文件标识、父目录标识、时间、原因、名称，重命名会产生旧父目录与新父目录两条记录：[USN_RECORD_V3](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-usn_record_v3)。
- 当检查点早于仍保留的日志时会产生 journal entry deleted 错误；journal ID 变更意味着必须重新取得当前日志并恢复索引：[READ_USN_JOURNAL_DATA_V0](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-read_usn_journal_data_v0)。
