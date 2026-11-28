# 栖知双端客户端与 macOS 快速文件查找开发计划

> 按阶段实施、审查并记录验收结果。

**目标** 在现有 Windows 功能及近期修复通过回归的前提下，交付可安装的 macOS 客户端和按名称、路径即时查找本机工作文件的能力。

**架构** 共用 Tauri 命令及业务界面，通过平台实现连接 Windows NTFS/USN 服务或 Mac 本地索引。Mac 的“今日／过去”和“快速查找”查询同一份元数据，文件操作继续经过 Rust 后端权限校验。

**技术栈** Tauri 2、Rust、React/TypeScript、SQLite、FSEvents、系统钥匙串、Vitest、Playwright。

**方案** [实现方案](../specs/2026-11-27-macos-client-fast-file-search-design.md)

## 全局约束

- 以 `4793917` 包含的 Windows 行为为回归下限。服务协议、服务数据库、凭据引用、NSIS 安装行为和原有命令保持兼容。
- Mac 首发按 Apple 芯片与用户选择的本机 APFS 工作目录验收。最低系统版本经实际构建验证后确定。普通刷新读取现有索引与待处理变动，首次或需要恢复时才后台核对目录。
- 文件发现只处理本地元数据。目录选择、排除、系统权限和文件类别在对应业务入口执行校验，旧结果执行动作前重新核对。
- 原有客户端命令保留。新增前后端字段使用 camelCase。Mac 索引可重建，日常恢复和重建不清空业务数据、凭据和配置。
- 同一阶段先证明测试能发现问题，再实现并复测。前一阶段验收通过后才进入依赖它的阶段。每个阶段独立审查，提交时按阶段限定文件。

## 重点检查

| 容易漏掉的输入或故障 | 应有表现 | 所属任务 |
| --- | --- | --- |
| 原有 Windows 用户选的工作目录是一条子目录路径 | 能找到所属 NTFS 卷，刷新能结束，原设置、凭据和中文片段搜索可用 | 1、2、6 |
| Mac 文件名仅大小写或 Unicode 编码形式不同 | 搜索能匹配，定位和复核仍能准确指向各自文件 | 2、5 |
| 建库一半撤销权限或切换排除规则 | 权限复核或新规则生效后相关目录停止出结果，旧任务无法重新发布 | 3、5 |
| 应用退出或休眠期间发生变动，或事件通知丢失 | 续接或补扫后能发现变化，故障目录不会影响其他目录 | 3 |
| 搜索结果被删除并在原路径换成另一份文件 | 旧结果提示刷新，后端不打开或移交替换后的文件 | 4、5 |

## 文件安排

| 位置 | 职责 |
| --- | --- |
| `apps/desktop/src-tauri/src/commands/today.rs`、`commands/settings.rs`、`app_state.rs`、`lib.rs` | 现有入口、索引运行状态和平台选择 |
| `apps/desktop/src-tauri/src/scan/{configuration,policy}.rs`、`today_workspace.rs` | 平台目录规则、缓存可见性和工作列表聚合 |
| 新增 `apps/desktop/src-tauri/src/file_index/mod.rs`、`file_index/windows.rs`、`file_index/macos/{mod,events,runtime,store,search}.rs` | 应用索引边界、原有 Windows 服务适配、Mac 工作线程、事件流与索引存储 |
| `apps/desktop/src-tauri/src/database/repositories/file_repository.rs`、`system/explorer.rs`、`config/secret_store.rs`、`codex/{process,runtime}.rs` | 稳定业务文件记录、原生操作、系统凭据与 Codex 运行 |
| 新增 `apps/desktop/src-tauri/src/commands/file_search.rs`、`apps/desktop/src/features/file-search/`，修改 `apps/desktop/src/lib/tauri.ts`、`apps/desktop/src/App.tsx` | Mac 快搜命令、界面和应用入口 |
| `apps/desktop/src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`、新增 `tauri.macos.conf.json`、`.github/workflows/ci.yml` | 平台依赖、安装包和双端验证 |

## 任务 1：建立 Windows 基线和 Mac 构建验证

- [x] 在 Windows 10/11 x64 测试机上验证正式版能安装、启动，NTFS 服务在运行且能响应。归档 `4793917` 源码和旧版安装包，统一在任务 6 详细测量基线与候选版。
- [x] 补齐已有的回归用例，覆盖 NTFS 子目录所属卷识别、刷新结束状态、中文片段和通配符匹配。Windows 专属用例在任务 6 实机运行。
- [x] 用现成的 Apple 芯片 Mac 记录 `tauri dev`、`cargo check` 和首个可启动版本的部署标记。正式最低系统版本在安装验收前定档。
- [x] 保存原始 Windows CI 已有结果及已定位的失败，保留复测输入和步骤。之后各阶段执行本机检查和对抗审查，远端 Windows 在任务 6 集中验收。

**阶段产出** 可重放的 Windows 回归数据、基线结果、Mac 启动卡点与后续真机条件。

## 任务 2：抽出平台边界，跑通 Mac 应用壳

**接口** `WorkspaceFileIndex::configure(&ScanRules) -> Result<(), IndexError>`、`WorkspaceFileIndex::refresh_range(LocalDayRange) -> Result<IndexSnapshot, IndexError>`、`WorkspaceFileIndex::status() -> IndexStatus`。`IndexSnapshot` 包含 `Vec<FileRecordInput>` 和覆盖状态，Mac 覆盖状态包含已完成、更新中或无法访问的各根目录。 `AppState` 持有平台实现，命令保留各自的输入输出与诊断映射。Mac 专用索引读写由任务 3 提供。

- [x] 补齐 `tests/today_workspace_command_test.rs` 和 `tests/scan_policy_test.rs` 的边界用例。Windows 检查 Configure、Sync、List 的调用次序与错误状态。Mac 检查排除优先、路径组件、中文路径、大小写目录和符号链接边界。
- [x] 实现 `file_index/windows.rs`，把现有 Windows 调用移入适配器。保留原消息格式和缓存写入路径。Mac 索引未接通前给出明确状态。只针对 Windows 编译服务启动分支以及需要的系统依赖。
- [x] 将目录验证与目录树归组接到平台路径语义。Windows 保留现有盘符、大小写和扩展路径处理。Mac 保留原始路径，使用组件关系判断归属。Mac 允许列表默认空，重启后空配置仍为空。Mac 排除规则变更后旧查询无法展开。
- [x] 跑通本机 Rust 回归、前端检查和端到端测试。验证 Mac 应用启动与 Windows 协议的本机用例，远端 Windows 启动和完整对照留到任务 6。

**阶段产出** 可启动的 Mac 应用壳与通过 Windows 回归的跨平台接入点。

**本机验收** 基于 `4137042`，Rust 格式检查、Clippy 和 235 项 Rust 测试通过，1 项本机 Codex 实连测试保持忽略。前端检查、190 项 Vitest 和 57 项 Playwright 通过。原生 macOS `.app` 可启动，实际操作“今日 → 过去 → 今日”及扫描设置已确认。对抗审查发现的应用数据排除、旧查询和不可用状态问题已修复并复审。

## 任务 3：实现 Mac 本地索引和增量恢复

**接口** `MacFileIndex::open(data_dir: &Path) -> Result<MacFileIndex, IndexError>`，由它实现任务 2 的接口。索引保存每个根的可用状态。进程内只允许一个索引写入者，每次读查询只看已提交版本，前台命令不在界面线程扫描。

- [x] 新增 `tests/macos_index_test.rs`，覆盖同卷双根部分可用、通知批次边界、权限变化、补扫、改名、删除、重启续接和 SQLite 失败。事务失败保留上次游标，失去权限时隐藏相关目录的文件。
- [x] 实现独立的 Mac SQLite 存储、按卷事件位置、按根提交状态和规则版本。重叠工作目录共享文件记录，按卷事务提交。发布前核对规则和根身份，启动、回到前台和读取快照时复核权限。
- [x] 接入 FSEvents。先监听再枚举，按批次处理根内变动。事件丢失或游标失效时补扫，超出本轮边界的事件留到后续处理。
- [x] 接通 Mac“今日／过去”。用本地日历计算日期，离线改名保留可核对的文件日期，在线改名记录观察时间。业务记录重复刷新保持同一 ID，确认消失的旧文件保留退役 ID，切换展示类别保留原记录。
- [x] 本机运行索引、权限、工作列表与数据库迁移测试。用真实 FSEvents 验证改名、删除及重新启动后的续接。使用原生 `.app` 验证“今日／过去”、排除目录和在线改名。

**阶段产出** 两端“今日／过去”均能返回可处理的文件，Mac 索引可重启恢复。

**本机验收** 250 项 Rust 测试、190 项 Vitest、57 项 Playwright 及格式、Clippy 检查通过。夏令时时间边界用美国洛杉矶时区额外复测。对抗审查发现的任务 3 问题已修复并复审。原生文件动作与身份复核见任务 4。

## 任务 4：接通系统操作、钥匙串及业务流程

- [x] 扩展 `tests/explorer_test.rs`，让 Mac 用例验证 Finder 参数、默认应用和文本编辑器选择、复制文件语义、删除确认后的结果，以及越权、文件删除或身份已变化时拒绝处理。复用当前文件校验层，使用本机 API 或现有 Tauri 能力完成实际调用。
- [x] 使用目标平台启用 `keyring` 的 `windows-native` 或 `apple-native`，将生产调用统一到系统凭据实现。Windows 保留服务名 `qizhi` 和原引用。Mac 用一条可清理的测试凭据验证保存、重启读取、掩码展示和删除，遇到钥匙串错误要返回可操作状态。
- [x] 在 Mac 从 Finder 启动应用，验证按系统环境或用户选择的可执行文件启动 Codex。平台专用检查放到对应分支，Mac 校验 app-server、账号和实际项目权限。先验证项目内资料可用、范围外资料不可用，再通过现有资料筐和交接链路完成一次任务及生成物查看。Windows 保留现有沙箱检查。
- [x] 用测试配置走“今日选中文件 → 资料筐／总结／RAGFlow 上传 → Codex 或智能工厂交接”，并验收 JEV 评估、知识库问答及智能工厂的演示和企业测试连接。运行文件操作、配置、Codex、资料筐及交接测试。各入口的真实结果与自动化结果分开记录。

**阶段产出** Mac 已有业务可使用，涉及密钥、原始文件和 Codex 权限的路径通过真机验收。

**本机验收** 252 项 Rust 回归、191 项 Vitest、57 项 Playwright，以及格式与 Clippy 检查通过。独立对抗审查已复核文件身份、已打开的文件句柄、每个文件打开时的最新规则与钥匙串提示。原生测试包核对了 Finder 定位和“今日 → 资料筐 → Codex 当前会话”。系统废纸篓、剪贴板文件 URL、登录钥匙串跨进程读取及清理通过原生用例。真实 Codex app-server 复用账号，完成一轮合成消息，并验证项目资料可读、项目外文件被拒绝、工作区可写。总结、RAGFlow、JEV、知识库问答和工厂企业连接使用自动化测试服务或替身覆盖，部署环境未联调。远端 Windows 留到任务 6。

## 任务 5：交付 Mac 快速查找

**接口** 新增 Tauri 命令 `search_local_files(input: FileSearchInput) -> Result<FileSearchPage, FileSearchError>`。输入含 `query: String` 和可空翻页游标，结果含至多 50 条、下一页游标和覆盖状态。条目含 `recordKey`、名称、路径、大小与修改时间。动作通过 `act_on_search_result(record_key: String, action: FileSearchAction) -> Result<(), FileSearchError>` 执行，动作含打开、定位、复制和加入资料筐。

- [x] 先写新增的 `tests/macos_file_search_test.rs` 与 `features/file-search/FileSearchPage.test.tsx`。断言 `合`、`合同`、`.pdf`、中文和英文路径片段、Unicode 等价形式能查到对应文件，历史文件可查，空输入不返回全量。覆盖 51 条翻页、同名异目录、旧查询晚到和旧结果同名替换。
- [x] 在 Mac 索引事务内维护长词和短词索引。用 FTS5 三字符索引查询三字符及以上的字面片段，用一至二字符索引处理短词，两路查询均受有效范围约束。由 Rust 生成稳定的排序与翻页顺序，前端每次最多接收 50 条。查询输入按普通文本处理。
- [x] 接入 Mac 快搜界面，输入后短防抖，应用过期响应忽略规则。显示可用工作目录、部分完成或权限提示，提供继续加载。文件动作按记录键查找并复核最新身份和目录权限，再调用任务 4 的系统能力与资料筐。Windows 保留原页面和入口。
- [x] 在 10 万条固定真机测试数据上，比较检索结果与文件清单，并分别测首次建库、热查询、变动延迟、恢复和索引体积。至少测 100 次热查询和 50 次单文件变动，查询样本包括一两个中文字、路径和高命中词。热查询从输入到首屏渲染记录 P95，目标不超过 150 毫秒。已监控文件单次变动到结果更新 P95 目标不超过 3 秒。把首次建库门槛随测试环境和原始测量数据一并归档。

**阶段产出** Mac 可以像 Everything 一样按文件名或路径快速找到授权范围内的文件，并能继续处理结果。

**本机验收** 100,000 个真实 APFS 文件逐条对照。首次建库 35.92 秒，108 次原生窗口首屏 P95 为 133 毫秒，50 次单文件变动到窗口更新 P95 为 1.14 秒。258 项常规 Rust、195 项全量 Vitest 和最新 4 项快搜组件用例、57 项 Playwright 通过。第三轮复审和随后复核已关闭所有快搜发现。详细读数见 [Mac 快速查找验收](../../testing/2026-11-27-macos-quick-search.md)。

## 任务 6：完成双端构建和安装验收

- [x] 在 CI 保留原 Windows 检查，另加 macOS 构建与适用测试。测试用固定平台数据，Windows 专用测试继续在 Windows 运行。Mac 单独执行前端检查、Rust 检查、平台测试和安装包构建。
- [x] Mac 用平台配置生成 `.app` 和 `.dmg`，用干净应用数据验证首次安装、启动和权限，用上一轮候选包的数据验证升级，验收后移除测试副本。
- [x] 在 Mac 用安装包复测索引和搜索主流程，确认只重建索引后设置、资料筐、工作记录和钥匙串仍可访问。在验收记录附安装包摘要、测试结果和适用范围。
- [x] Windows 用原入口生成 `4137042` 对照版与候选版的 NSIS 安装包，用同一批文件和已保存的扫描配置对照两个版本，记录服务侧增量耗时，核对 P95 增幅是否超过 10%。
- [ ] Windows 原发布验收还包括新用户安装、启动、权限和卸载，旧正式版数据和凭据升级对照，以及跨日用例。根据用户决定，本轮保留现有 Windows 证据。
- [ ] 公开分发前完成签名公证、远端 CI，并在最低目标系统和另一系统登录账户核验 Mac 首次安装、启动、权限和移除。若实际发布验收发现性能、权限或恢复问题，处理后复测。

**阶段产出** 可被双端持续验证的发布流程与可交付的安装包。

**本机交付范围** 2026-11-27 用户确认剩余工作仅在本机 macOS 收尾。Apple 芯片 Mac 的安装包已从磁盘映像安装并启动，验证了干净应用配置下的首次运行、授权和排除目录、快搜分页、资料筐、「今日」和「过去」、上一轮独立数据升级、重建索引与移除测试副本。安装包还通过了十万文件路径比对、在线新增、改名与删除，以及重启后的离线改名恢复。

**Windows 已取得结果** 同机生成并打开两个 NSIS 安装包，候选版保留对照版扫描设置，两版各 20 次服务侧增量测试通过，候选版「今日」新增显示、通配符搜索、目录分组、分页及批选已实测。Windows 验收收在现有证据范围，原清单中剩余的 Windows 场景保留实际状态。macOS 15.0 实机、另一系统登录账户、远端 GitHub CI 和公开分发签名公证属于发布验收。见 [双端安装验收](../../testing/2026-11-27-dual-desktop-release-check.md)。

## 开工确认

建议以本文的 Apple 芯片、本机 APFS 工作目录范围和性能目标开工。最低系统版本与首次建库门槛交由第一轮真机数据确定。Windows 快搜是否也要新增全范围入口，可以在 Windows 现有功能通过回归后作为单独需求确认。
