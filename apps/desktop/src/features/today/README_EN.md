# Today / Recent

[中文](README.md) | [English](README_EN.md) | [Feature modules](../README_EN.md)

This module turns local file activity into an actionable workspace: query Today or the previous five days, group by directory, search/filter, select in batches, run JEV value assessment, generate work summaries, upload to RAGFlow, and hand materials to a Codex project.

- `TodayPage.tsx`: page state, queries, selection, and cross-feature actions.
- `WorkspaceTreeTable.tsx`: compact directory/file tree table and context menus.
- `SummaryResultDialog.tsx`: streamed Markdown summaries, copy, save, and upload.
- `today.test.tsx`: regression coverage for filtering, grouping, batch selection, summaries, and handoffs.

Selections depend on the backend `queryId` snapshot. Once a handoff or summary dialog opens, it must use the frozen selection so a list refresh cannot change the chosen materials.
