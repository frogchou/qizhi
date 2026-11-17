# PPT 制作智能体

能力名：`presentation.create`。中台向其提供演示简报、受众、语言、页数和可选资料；它在中台分配的任务目录中调用本机已登录的 Codex CLI，输出 `presentation.pptx`、`ppt-qa.json` 和协议结果。

## 验收约束

- 只以任务目录作为工作根目录；不把企业资料发送到其他服务。
- Codex 必须用 PptxGenJS 生成文件，并执行内容检查和至少一次渲染后的视觉检查/修复循环。
- `ppt-qa.json.passed` 为 `false` 时，任务仍返回产物但携带 `presentation_qa_not_passed` 风险，等待中台或人工处置。
- 管理员确认返工时，中台会把上一版 PPT、验收标准、质量报告和 `retry-context-*.md` 一并放入 `referenceMaterials`。Codex 必须阅读这些任务本地材料并逐项修复质检问题，不能把返工当作全新、无上下文的生成。
- Codex 内容生成没有默认总时限；运行期间会把 Codex 子进程状态、累计时长及最近输出新鲜度回传中台。控制台显示“Codex 进程仍在运行”只表示子进程仍存活，不把它误报成已经完成。
- 自检仅确认 `codex --version` 可用，不生成文件、不访问业务资料。

## 独立实例协议

PPT 智能体由共享运行时加载任务信封，只读取本节点目录中的中台材料化证据。完成后共享运行时原子写入 `result.json` 并以本次租约回调中台；中台会再校验 `presentation.pptx` 的路径与 SHA-256。
