import { describe, expect, it } from "vitest";
import { canAccept } from "./assembly-model";
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
  it("requires the bound sample outcome and required assertion evidence", () => {
    expect(canAccept(run)).toBe(true);
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
