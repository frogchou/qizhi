# 栖知双端开发基线与 Windows 复测记录

**第一阶段预检基线** `4793917ff4c0e84031424d2650274e34f0ca6ea4`

**最终对照的上游基线** `4137042587086dcf2aeab58901ac38270eee4592`

**对应任务** [开发计划第一阶段](../superpowers/plans/2026-11-27-macos-client-fast-file-search.md#任务-1建立-windows-基线和-mac-构建验证)

## 已有基线证据

| 环境 | 证据 |
| --- | --- |
| Windows Server 2025 x64 的 GitHub Actions | 运行 `45334793707` 检出合并预览 `f29150c`。用 Git 核对该提交与 `4793917` 的源码树均为 `a2641fa828dfc90552ae8c4dae003fd2df5ce241`。前端检查、154 项 Vitest、Rust 格式、Clippy、Rust 测试和 37 项 Playwright 通过。 [成功运行](https://github.com/frogchou/qizhi/actions/runs/45334793707) |
| Windows 合入后的 GitHub Actions | 运行 `45355908173` 在 Codex 回车发送的前端测试失败，Rust 和 Playwright 未执行。延迟加载会话可稳定复现草稿丢失。阶段修复让会话就绪前保留草稿并禁用发送。 [失败运行](https://github.com/frogchou/qizhi/actions/runs/45355908173) |
| Apple 芯片 Mac，macOS 27.2.1，Node 24.21.0，pnpm 11.7.0，Rust 1.100.0 | 原始基线 `pnpm check`、154 项 Vitest、37 项 Playwright、`cargo fmt --check`、`cargo check --locked` 通过。Windows 命名管道的未使用导入、未使用函数以及非按目标配置的依赖产生编译警告。 |
| Mac 原生开发窗口 | `tauri dev --no-watch` 编译并启动原生 arm64 进程。窗口服务确认 1280 × 820 窗口，测试标识的数据目录生成 SQLite。使用本机 Command Line Tools 即可构建开发版。此运行验证了应用壳，文件发现仍依赖 Windows 索引服务。macOS 签名、公证和安装包留到发布阶段验证。 |
| 第一阶段修订后的 Mac 回归 | 前端检查、160 项 Vitest、37 项 Playwright、Rust 格式和 8 项针对性 Rust 测试通过。Rust 集成测试经桌面工作区查询入口覆盖中文片段及通配符。Windows 卷真实识别用例的运行仍需要 Windows 环境。 |
| Windows 11 专业版实机预检（2026-11-27） | 通过远程桌面访问 10.0.26100、AMD64 的测试机。C、D 均为固定 NTFS 卷，初查栖知和索引服务未安装。在 D 盘独立目录复制并核对 `4793917` 源码和两版旧安装包的 SHA-256，创建了带实时时间戳的历史样本。工具链、安装升级、索引服务和性能另行验收。 |
| Windows 11 基本运行（2026-11-27） | 正式版 v0.1.0 安装并打开窗口。设置保存后，磁盘配置只包含独立测试目录。`QizhiNtfsIndexer` 为 `Running`，其管道健康检查和两个日期区间的列表请求均返回 `ready`。本轮刷新后界面显示 0 个文件，详细文件命中在最终验收复测。 |
| Windows 11 原始基线前端（2026-11-27） | 在同一台 Windows 测试机用 Node 22.22.0 和 pnpm 11.7.0 运行 `4793917`。前端检查、154 项 Vitest 和 37 项 Playwright 通过。 |

Windows Server 自动化覆盖已声明的测试用例。Windows 11 的索引服务和性能对照以及未覆盖的升级场景见 [双端安装验收](2026-11-27-dual-desktop-release-check.md#windows)。

开发分支已更新到 `4137042`（0.1.9）。上游更新了智能工厂、桌面通知和入口，Windows NTFS 索引与扫描后端未变。Codex 回归修复接入了上游统一通知。历史记录仍对应各自的安装包和提交，最终性能数据以更新后的上游为对照。开发阶段仅做本机验证，远端 Windows 在任务 6 集中验收。

早期开发包的 Mach-O 部署标记为 macOS 11.0。当前安装包的最低版本配置为 macOS 15.0，安装验收在 macOS 27.2.1 完成。

第一阶段对抗审查发现并复现了 Codex 同项目新会话交接、待用资料延迟、侧栏读取失败和旧请求晚到等问题。已增加回归用例并复审。按 2026-11-27 确认的范围，开发各阶段检查 Windows 基本运行。下列完整复测步骤在功能开发完成后统一执行。

## Windows 10/11 x64 复测步骤

用可安装 Windows 服务的测试机、普通用户启动的应用和一块本机 NTFS 固定磁盘。所有输入和凭据使用测试数据。

1. 记录 Windows 版本、机型、CPU、内存、磁盘、测试目录和运行时间。用正式的 [v0.1.0 x64 安装包](https://github.com/frogchou/qizhi/releases/tag/v0.1.0) 安装旧版。保存一个测试服务地址、一个测试密钥和一项非默认设置，记录设置页的掩码与连接状态。另用正式的 [v0.1.1 x64 安装包](https://github.com/frogchou/qizhi/releases/tag/v0.1.1) 验证同版本覆盖安装，分开记录结果。
2. 测试日前一天，在 PowerShell 创建一个测试目录并写入 `昨日验收.md`。在旧版中将该目录选作允许范围，确认该文件能搜到并记录日期。次日将该目录路径作为下方脚本的 `$root`，加入本日文件。排除其中的 `排除目录`。保持同一套配置和操作顺序，两组对照尽量在同一个本机自然日完成。
3. 从任务 6 选定的上游基线源码执行 `pnpm install --frozen-lockfile` 和 `pnpm --filter @qizhi/desktop tauri build`，记录产物的 SHA-256。关闭桌面应用后安装基线包，记录原有设置与凭据是否能读取，并用 `Get-Service -Name QizhiNtfsIndexer` 核对索引服务在运行。在 Rust 目录以普通用户运行 `cargo test --test ntfs_ipc_policy_test -- --ignored`，核对真实管道可连通。
4. 检查允许目录中的“今日／过去”结果、分页、目录展开和批量选择。“过去”应当显示 `昨日验收.md`。“今日”应当包含脚本生成的 207 个 Markdown 文件，排除目录内的文件缺席。`测试` 应匹配 `测试测试1124.md`，`周*.md` 应匹配 `周报.md`。展开“分页”目录，核对首批 200 项和余下 5 项，并核对批选数量。批选提交文件前先确认预览的数量。
5. 检查刷新能恢复为可再次操作的状态。首次建库在一份全新安装、尚无该卷索引的测试快照上测量。旧数据升级场景另记。增量测试每轮在工作根新建一个唯一命名的 Markdown 文件（如 `增量-001.md`），从点刷新计时到按钮恢复，按文件名确认当轮新文件出现，再开始下一轮。基线与候选包各做至少 20 轮，用相同文件数量与操作顺序，保留每轮耗时、可见条数和失败原因。
6. 在同一台机器上跑完 Windows CI 的前端检查、Vitest、Rust 格式、Clippy、Rust 测试、Playwright。用上述相同输入复测最终候选包，核对升级、服务和结果。以每组样本计算 P95，按计划检查相对增幅。最后在测试环境验证卸载，检查服务已经移除。

测试数据使用最小 Markdown 文件，便于在两次运行中比对确切名称、过滤和分组。生产业务环境无需创建这些资料。

```powershell
$root = Read-Host "输入昨日已纳入索引的工作目录完整路径"
if (-not (Test-Path -LiteralPath (Join-Path $root "昨日验收.md") -PathType Leaf)) {
    throw "请先准备并索引昨日验收.md"
}
$many = Join-Path $root "分页"
$excluded = Join-Path $root "排除目录"
New-Item -ItemType Directory -Path $many, $excluded | Out-Null
Set-Content -LiteralPath (Join-Path $root "测试测试1124.md") -Value "# 测试"
Set-Content -LiteralPath (Join-Path $root "周报.md") -Value "# 周报"
Set-Content -LiteralPath (Join-Path $excluded "不可见测试.md") -Value "# 排除"
1..205 | ForEach-Object {
    $name = "分页-{0:D3}.md" -f $_
    Set-Content -LiteralPath (Join-Path $many $name) -Value "# $name"
}
Write-Output $root
```

中文文档文件名的两条验收分别由自动化用例覆盖 `测试测试1124.docx`／`周报.docx`，以及本手工集覆盖对应的 Markdown 文件。这样手工测试也能用无 Office 依赖的真实文件。
