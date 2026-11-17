# 互联网研究与核验 2.0.0

能力名 `research.web`。从控制台提交问题可查看节点答复、引用和可下载文件。包保存在独立目录，沿用平台发现、管理员审核、自检和注册程序。

## 输入与执行

`query` 是研究目标，`requirements` 是可选验收要求，`language` 默认为中文，`maxResults` 限制最终引用来源数（1–10）。使用任务目录 task.json 的 createdAt 解析相对日期，Codex 根据目标地点换算时区。

第一阶段由 Codex 实时搜索产生候选地址和期望类型。程序独立读取公开 HTTPS 来源，检查每次重定向和解析地址，拒绝非公开 IPv4 地址、异常 HTTP 状态、伪 JSON、过大的响应及常见验证页面。每个来源限时 12 秒。当前支持 HTML、JSON 和纯文本以及 IPv4 域名。PDF、登录态、JavaScript 渲染和 IPv6-only 站点不在此版本范围内。

第二阶段 Codex 从已取回的有界正文提取结论，逐条提供来源编号和连续原文，检查资料时间、地点和信息冲突。程序校验原文确实出现，再生成带引用的回答。有缺项时最多补查一轮。候选数与正文窗口有界。原文匹配证明引用可追溯，结论语义、时效和换算仍依赖模型判断，必要时可由质管智能体或人工复核。

## 交付与监控

coverage 为 complete、partial、insufficient。部分答复标明缺项，零有据结论返回 failed。research-report.md 包含答复与来源，sources.json 保存获取时间、访问地址、结论、原文、拒绝原因和缺项。两个文件均按平台协议归档。

复用实例租约和任务 SSE。progress 对应公开搜索、实际读取、舍弃、补查和综合阶段，heartbeat 展示 Codex 存活状态。原始网页、模型提示和凭据不作为进度正文。每次 Codex 调用的日志按尝试编号和轮次存放在节点 research-runs/ 下。停止任务由节点管理服务停止运行单元。使用现有任务、节点结果、工件及事件表，无数据库迁移。

## 验证

tests/agents/web-research-v2.spec.ts 验证 HTML 伪 JSON、补查成功、无证据和引用不匹配。线上可提交“今天的纽约市的天气情况是什么？”，核对版本、当地日期、实际引用与工件。独立运行 `corepack pnpm exec tsx scripts/smoke/web-research.live.ts` 可以在 219 使用测试目录验证真实模型与公网读取。
