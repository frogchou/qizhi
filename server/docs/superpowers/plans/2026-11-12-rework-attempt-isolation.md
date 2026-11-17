# Rework Attempt Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a human-requested rework from treating any prior Codex message, PPT, or quality file as a new attempt result.

**Architecture:** Each Codex invocation clears its invocation-final-message sentinel before starting, so completion can only come from that process. A rework receives prior delivery solely under `input/`; the active node-output files are cleared and agents reject output whose hash or modification time proves it predates the current attempt.

**Tech Stack:** TypeScript, Vitest, Node.js filesystem APIs, Codex CLI runner.

**Spec:** Production diagnosis for task `66bb1f62-7366-4d83-958b-0856acc2df8e` on 2026-11-12.

## Global Constraints

- Keep archived task artifacts immutable.
- Preserve prior delivery only in explicit task-local `input/` files.
- A retry must fail visibly rather than claim success when Codex does not produce fresh output.
- Do not introduce a fixed execution timeout for content-producing Codex agents.

## Review Focus

- A stale `.mg-codex-last-message.txt` must never complete a new invocation.
- An existing `presentation.pptx` or `ppt-qa.json` must never satisfy a rework attempt.
- A failed cleanup must stop the rework before any agent is launched.
- Quality rework must use the new PPT input, not a prior quality result.

---

### Task 1: Make Codex final-message completion invocation-scoped

**Files:**
- Modify: `packages/codex-runtime/src/index.ts`
- Test: `tests/codex-runtime/codex-cli-runner.spec.ts`

- [ ] Write a failing runner test that seeds a prior final-message file and verifies it is removed before the child can be considered complete.
- [ ] Run the test and verify it fails because the existing sentinel is observed as final output.
- [ ] Clear the runner sentinel immediately before spawning Codex and require the file to be newly produced by that invocation.
- [ ] Run the runner tests and verify they pass.

### Task 2: Isolate rework outputs and reject stale PPT agent files

**Files:**
- Modify: `apps/control-plane/src/tasks/task-workspace.service.ts`
- Modify: `apps/control-plane/src/tasks/tasks.service.ts`
- Modify: `agents/ppt-maker/src/run-task.ts`
- Test: `tests/control-plane/task-review.e2e-spec.ts`
- Test: `tests/agents/ppt-maker.spec.ts`

- [ ] Write failing tests for clearing active PPT/quality result files before a rework and for rejecting an unchanged old PPT output.
- [ ] Run the tests and verify the stale files currently allow a false success.
- [ ] Add narrowly scoped cleanup of active outputs before scheduling the PPT and quality nodes; retain only immutable archived files and explicit `input/` materials.
- [ ] Capture baseline file fingerprints at agent start and reject outputs unchanged from the baseline.
- [ ] Run the affected tests and verify they pass.

### Task 3: Verify the repair and operational behavior

**Files:**
- Modify: `apps/control-plane/src/tasks/README.md`
- Modify: `docs/runbooks/control-console.md`

- [ ] Document the fresh-output invariant and the expected visible failure if Codex exits without producing new files.
- [ ] Run type check, full tests, agent validation, and production console build.
- [ ] Deploy the verified worktree to 219 and run a focused live rework regression.
