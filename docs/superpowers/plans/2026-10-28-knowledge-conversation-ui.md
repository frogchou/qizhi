# Knowledge Conversation UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the knowledge page as a prototype-faithful conversation workspace with a right-side resource scope.

**Architecture:** Keep the existing RAGFlow command boundary and move only presentation state into `KnowledgePage`. The page holds in-memory conversation turns and recent questions; CSS establishes an app-height grid whose message and resource subpanels own their scroll behavior.

**Tech Stack:** React 19, TypeScript, Vitest, existing Tauri command adapter, CSS.

**Spec:** `docs/superpowers/specs/2026-10-28-knowledge-conversation-ui-design.md`

## Global Constraints

- Retain `queryRagflowKnowledge({ question, datasetIds, agentIds })` and do not expose RAGFlow keys in React.
- Use the supplied prototype as the visual reference and avoid a results-below-controls layout.
- Do not add dependencies or network calls.

## Review Focus

- Multiple selected data sets and Agents must reach the existing command unchanged; Task 1 test asserts the exact payload.
- A failed Agent must remain visible without suppressing a successful Agent or source; Task 1 test asserts both states in one turn.
- Dataset lists larger than the panel must scroll within the dropdown; Task 2 CSS and browser verification exercise the constrained panel.
- A second question must append a second turn rather than replace the first; Task 1 test asserts two user messages.
- An unconfigured RAGFlow setup must display its actionable error without rendering a fake successful reply; Task 1 preserves the existing error test.

---

### Task 1: Conversation state and semantic markup

**Files:**

- Modify: `apps/desktop/src/features/knowledge/KnowledgePage.tsx`
- Modify: `apps/desktop/src/features/knowledge/knowledge.test.tsx`

**Interfaces:**

- Consumes: `QizhiCommands.queryRagflowKnowledge(input)`.
- Produces: in-memory conversation turns rendered as user question, Agent result blocks, and expandable source citations.

- [ ] Write failing component tests for an unchanged multi-resource payload, one conversation turn with Agent answers/errors and `引用来源`, and a second submitted question.
- [ ] Run `pnpm --filter @qizhi/desktop test -- --run src/features/knowledge/knowledge.test.tsx` and confirm the current page fails.
- [ ] Implement `ConversationTurn[]`, the initial/follow-up composers, right-side `details` selectors, Assistant answer blocks and source disclosure.
- [ ] Run the focused test and confirm it passes.
- [ ] Commit `feat: redesign knowledge conversation flow`.

### Task 2: Prototype-faithful layout and scroll containment

**Files:**

- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.css`
- Modify: `apps/desktop/src/features/knowledge/knowledge.test.tsx`

**Interfaces:**

- Consumes: semantic classes from Task 1.
- Produces: a fixed-height main/rail layout with independently scrolling message and resource panels.

- [ ] Write a structural test for `knowledge-conversation`, `knowledge-rail`, and the initial composer named `询问你的工作知识库`.
- [ ] Run the focused test and confirm current markup fails.
- [ ] Add the `knowledge-workspace-shell` route class, fixed conversation grid, compact resource rail cards, selected resource rows, bubbles, assistant panels, citations and responsive fallback.
- [ ] Run `pnpm --filter @qizhi/desktop test -- --run` and `pnpm --filter @qizhi/desktop check`; inspect the desktop rendering and confirm only inner panels scroll.
- [ ] Commit `style: align knowledge workspace with prototype`.
