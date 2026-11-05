# 设置

[中文](README.md) | [English](README_EN.md) | [功能模块](../README.md)

该模块集中管理扫描与隐私规则、OpenAI 兼容服务、JEV、RAGFlow、Codex 偏好和今日总结提示词。

- `SettingsPage.tsx`：设置页面布局、连接测试和扫描目录选择。
- `SummarySettingsSection.tsx`：可增删的总结提示词与默认模板。
- `CodexSettingsSection.tsx`：Codex CLI 状态、模型和推理强度。

密钥输入仅用于写入 Windows 凭据管理器，重新读取设置时只返回掩码状态。目录通过系统选择器添加，保存后应给出明确反馈并立即影响“今日”查询。
