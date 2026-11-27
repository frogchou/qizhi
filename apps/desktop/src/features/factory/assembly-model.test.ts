import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { canAccept, trialBlock, useRequestId } from "./assembly-model";
const run = {
  id: "r",
  candidateId: "c",
  taskId: "t",
  createdAt: "2026-11-25",
  state: "awaiting_review",
  accepted: false,
  assertions: [{ name: "有效日", required: true, passed: true }],
  criteria: [{ id: "R1", priority: "required", requirement: "列出差异" }],
  findings: [{ id: "R1", status: "met" }],
};
describe("matching sample acceptance", () => {
  it("explains missing runtime execution evidence without asking for a picture", () => {
    const block = trialBlock({
      ...run,
      businessReview: { status: "native_session_missing", criteriaIds: [] },
    });
    expect(block?.message).toMatch(/运行时.*记录/);
    expect(block?.message).not.toMatch(/PNG|图片/);
    expect(block?.action).toBe("sample");
  });
  it("requires the bound sample outcome and required assertion evidence", () => {
    expect(canAccept(run)).toBe(true);
    expect(
      canAccept({
        ...run,
        state: "accepted",
        reviewDecision: "accept",
        businessReview: { status: "native_file_missing", criteriaIds: [] },
      }),
    ).toBe(false);
    expect(canAccept({ ...run, candidateCompleted: false })).toBe(false);
    expect(
      canAccept({
        ...run,
        criteria: [{ id: "N1", priority: "optional", requirement: "格式" }],
      }),
    ).toBe(false);
    expect(canAccept({ ...run, state: "running" })).toBe(false);
    expect(canAccept({ ...run, assertions: [] })).toBe(false);
    expect(
      canAccept({
        ...run,
        assertions: [{ name: "样式", required: false, passed: true }],
      }),
    ).toBe(false);
    expect(
      canAccept({ ...run, findings: [{ id: "R1", status: "missing" }] }),
    ).toBe(false);
    expect(canAccept({ ...run, accepted: true })).toBe(false);
  });
});

it("keeps an unacknowledged feedback request when another trial is submitted", () => {
  const { result } = renderHook(() => useRequestId());
  const first = result.current.forPayload(
    { feedback: "增加列名" },
    "trial-one",
  );
  const second = result.current.forPayload(
    { feedback: "增加列名" },
    "trial-two",
  );
  expect(first).not.toBe(second);
  result.current.confirmed("trial-two");
  expect(result.current.forPayload({ feedback: "增加列名" }, "trial-one")).toBe(
    first,
  );
  expect(
    result.current.forPayload({ feedback: "增加日期" }, "trial-one"),
  ).not.toBe(first);
});
