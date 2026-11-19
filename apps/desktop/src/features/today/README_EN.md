# Today / Recent

[中文](README.md) | [English](README_EN.md) | [Feature modules](../README_EN.md)

This module turns local file activity into an actionable workspace: query Today or the previous five days, group by directory, search/filter, select in batches, run JEV value assessment, generate work summaries, upload to RAGFlow, and hand materials to a Codex project.

- `TodayPage.tsx`: page state, queries, selection, and cross-feature actions.
- `WorkspaceTreeTable.tsx`: compact directory/file tree table and context menus.
- `SummaryResultDialog.tsx`: streamed Markdown summaries, copy, save, and upload.
- `today.test.tsx`: regression coverage for filtering, grouping, batch selection, summaries, and handoffs.

Selections depend on the backend `queryId` snapshot. Once a handoff or summary dialog opens, it must use the frozen selection so a list refresh cannot change the chosen materials.

Image discovery is opt-in under Settings → Scan & Privacy → Image Search. The Images filter supports JPG/JPEG, PNG, WebP, TIF/TIFF, and GIF, with a visible Upload action plus the existing context-menu upload. Images are excluded from JEV assessment and work summaries. The destination RAGFlow dataset remains responsible for choosing OCR or a vision-model parser after upload.
