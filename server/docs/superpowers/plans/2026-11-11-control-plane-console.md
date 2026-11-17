# 中台控制台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a same-origin web console on 219 that submits demand signals, approves agents, shows results, and monitors real task processing.

**Architecture:** Keep the control plane as the API authority and make task execution asynchronous. Add durable task summary/detail read models, then build a React/Vite dashboard served by the existing Fastify control-plane process at `/console/`.

**Tech Stack:** NestJS/Fastify, TypeORM/PostgreSQL, React 19, Vite, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-control-plane-console-design.md`

## Global Constraints

- Browser must never contain the administrator token in static source or persistent browser storage.
- Task monitoring must come from persisted control-plane records, not mocked frontend state.
- The current runtime dispatch scope is explicitly shown as knowledge retrieval only.
- UI must be served from the 219 control-plane host at `/console/`.

## Review Focus

- A task that finishes before the first poll still shows result and all stages.
- A RAGFlow failure changes task/node/attempt states without leaving a false running stage.
- An unauthorized API response returns the console to its token prompt without exposing token text.
- Multiple recent tasks are selectable and their events cannot bleed into one another.
- A narrow viewport retains the task submit and stage details without horizontal overflow.

### Task 1: Durable task monitor API

**Files:** `apps/control-plane/src/tasks/*`, `tests/control-plane/*`

- [ ] Write failing tests for async task creation and task detail stage projection.
- [ ] Implement background execution, list/detail queries, failure persistence and derived workflow stages.
- [ ] Run task tests and the full TypeScript test suite.

### Task 2: React control console

**Files:** `apps/console/*`, `tests/console/*`

- [ ] Write failing tests for workflow projection and token handling helpers.
- [ ] Implement React app shell, demand signal form, approval list, task result inspector and auto-refresh workflow timeline.
- [ ] Build the console and run its unit tests.

### Task 3: Same-origin deployment and verification

**Files:** `apps/control-plane/src/main.ts`, `infra/systemd/*`, `docs/runbooks/*`

- [ ] Test that static console configuration resolves `/console/` without shadowing API routes.
- [ ] Register static files, build/deploy to 219 and restart the service.
- [ ] Perform browser desktop/mobile QA, a real task submit/poll/approval flow, full test suite and document access.
