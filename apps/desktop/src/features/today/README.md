# 今日 / 过去

[中文](README.md) | [English](README_EN.md) | [功能模块](../README.md)

该模块把本地文件活动整理成可操作的工作台：查询今日或过去五天的文件、按目录聚合、搜索与筛选、批量选择、JEV 价值评估、工作总结、上传 RAGFlow，以及向 Codex 项目发送资料。

- `TodayPage.tsx`：页面状态、查询、选择和跨模块动作。
- `WorkspaceTreeTable.tsx`：紧凑的目录/文件树表格和右键菜单。
- `SummaryResultDialog.tsx`：流式 Markdown 总结、复制、保存和上传。
- `today.test.tsx`：筛选、聚合、批量选择、总结和交接回归测试。

文件选择依赖后端返回的 `queryId` 快照。打开交接或总结对话框后应使用冻结的选择，避免刷新列表导致资料错位。
