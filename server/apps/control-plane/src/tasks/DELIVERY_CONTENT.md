# 可阅读的任务成果

用户请求文件分析时，交付应包含每份文件的内容总结和用途说明。节点返回成功、质检通过或生成 JSON 记录不等于已经交付这些内容。

## 数据约定

智能体使用 `AgentResult.output.answer` 返回完整 Markdown 正文；`output.text` 是兼容的正文入口。`output.summary` 只用于简述，不覆盖非空正文。真实交付文件仍由协议 `artifacts` 声明路径和 SHA-256，可选 `output.deliveryArtifactPaths` 指明其中哪些文件直接交给用户。文件分析智能体同时返回正文和内容一致的 Markdown 报告。

`GET /v1/tasks/:id` 的 `delivery` 字段为权威展示模型：

| 字段 | 含义 |
| --- | --- |
| revisionNumber | 当前人工修订号，初始为 0 |
| answers[].nodeKey | 产出正文的节点键 |
| answers[].title | 可阅读的成果标题 |
| answers[].body | 未截断的完整正文 |
| answers[].format | Markdown 或纯文本 |
| artifactIds | 直接交付文件在 `artifacts` 列表中的 ID |
| supportingArtifactIds | 过程和质检附件的 ID |

字段存在时前端必须采用它，包括空数组，不能又回退到旧计划中的结果。前端先展示正文，随后展示交付文件；辅助记录默认折叠。Markdown 不执行 HTML 或脚本，链接受安全协议限制。

## 筛选与历史兼容

`delivery-content.ts` 负责统一投影。工单详情和交付中心使用同一规则，自动验收也使用同一正文提取与节点选择逻辑，人工退回时保存相同的完整正文。

1. 只选当前计划中已成功完成的结果；新修订尚未得到计划时返回空成果，上一版仍留在历史记录。
2. 已被下游制作节点消费的检索笔记等不充当最终正文；并行的独立成果分别保留。
3. 制作成果优先，质检结论作为辅助。历史上只有审阅节点的任务，从完整 `findings[].message` 恢复分析正文，不以“审阅已完成”概述替代。
4. 根据当前结果的文件路径和 SHA-256 匹配归档；旧计划、失败尝试及不匹配的旧文件不会混入本次成果。
5. 仅质量能力产生的已知 `acceptance-criteria.json` 和 `quality-assessment.json` 默认属于辅助记录，不会把所有 JSON 视为过程文件。用户要求的 JSON 数据成果照常可下载。
6. 原始节点结果、验收记录和文件归档保持不变；本次无需数据库迁移。

## 验证

`tests/control-plane/delivery-content.spec.ts` 覆盖旧版两份同名 README 分析、长正文、制作和质检区分、合法 JSON 交付、旧计划/修订/尝试排除与并行叶子结果。`delivery-acceptance.spec.ts` 验证验收读取实际完整正文。`factory.e2e-spec.ts` 覆盖交付中心兼容与权限。独立测试数据库不得使用运行数据库。

新能力见 [文件内容分析智能体](../../../../agents/document-analysis/README.md)。旧工单无需重新执行，只要打开更新后的客户端，即可从既有完整结果中阅读分析内容；原有人工验收状态不变。
