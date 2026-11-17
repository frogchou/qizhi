# 文件内容分析智能体

独立 Agent Protocol v1 服务，能力为 `document.analyze`，内部使用共享 Codex 运行时。它负责读取任务授权的文件、总结内容、解释用途并给出原文依据，直接交付用户可阅读的完整答复。普通文件分析不依赖质量验收智能体。

## 输入与绑定

`requirements` 是用户要求的实质分析内容，`referenceMaterials` 是 1–30 个任务目录内的相对文件路径。规划器应以 `referenceMaterials: []` 初始化，并通过 `taskInputBindings` 逐项绑定真实资料 ID；也可绑定上游 `artifact_paths` 或 `evidence_markdown`。注册器会读取 `schemas/input.schema.json`、`schemas/result.schema.json`，不需要扩展全局协议。

服务会读取每个目标并验证文件边界。对于 `TaskEnvelope.taskInputs` 中的附件，还会校验大小与 SHA-256，使用完整的 `displayName` 和唯一的 `id`；同名文件分别分析，来源不会因文件名相同而合并。没有附件元数据的上游文件使用相对路径生成稳定 ID。

## 可读取的文件

- UTF-8 或带 BOM 的 UTF-16 文本、Markdown、JSON、CSV/TSV、XML/HTML、YAML 等文本文件。
- PDF：本地有 `pdftotext`，或 Python 与 `pypdf` 时提取文字。
- DOCX、PPTX、XLSX：本地 Python 标准库提取包内文字，不执行宏或公式。XLSX 中公式与已缓存值分别标记，不把缓存值称为重新计算结果。

不提供 OCR、图片语义分析、旧版 `.doc/.ppt/.xls` 转换或 Office 排版分析。PDF/Office 报告明确说明依据可提取文字。缺少提取工具、损坏/加密文件、空文件、无文字扫描件与不支持的格式会明确失败，不伪造摘要。单文件上限 20 MiB、解压 Office 上限 80 MiB、全部提取文字上限 600000 字符；超限会失败，不静默截断资料。每次本地格式提取最多等待 60 秒；Codex 内容分析沿用共享运行时，没有额外总时限。

## 交付保证

服务先校验和读取全文，再把文字作为数据交给 Codex 的受约束输出。内容合成禁止网络和 Shell，保留共享 `onStatus` 心跳和 `onOutput` 过程事件。分析必须覆盖全部真实资料 ID，并提供能够在对应全文中找到的连续原文摘录（允许换行/空白差异）。结构不完整或依据不匹配时允许一次修复；仍不合格则失败。模型的“已完成”消息不能代替报告。

- `output.answer`：完整 Markdown 正文，包含总览、逐文件用途、内容总结、关键要点、来源和原文依据。
- `output.documents`：以 `documentId` 区分的结构化记录，保存原名、相对路径、SHA-256、用途、摘要及原文摘录。
- `output.summary`：简短交付状态，不能作为最终正文替代品。
- `evidence`：协议原生来源记录，保留完整 `title`、`documentId`、有意义的 `source` 与真实 `excerpt`。
- `artifacts`：真实 UTF-8 Markdown 文件的相对 `path` 和 SHA-256；文件内容与 `output.answer` 完全相同。
- `output.deliveryArtifactPaths`：明确标出该 Markdown 交付路径，便于展示层区分交付文件和运行记录。

每次调用在节点目录下创建独立 `document-analysis-*` 工作目录，原始资料只读。报告由服务从已校验内容生成，重试不会复用历史报告。共享运行时保存协议结果并进行租约回调。

## 验证

`../../node_modules/.bin/tsx src/self-check.ts` 使用现有 `AgentManifestSchema` 和 `Value.Check` 验证清单、确认 JSON 声明结构与 Codex CLI 存在；不读取企业资料、不调用模型。集成回归覆盖 `tests/agents/document-analysis.spec.ts`。
