import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PackageUpgrade } from "./PackageUpgrade";
import { factoryApi } from "./factory-client";

const source = {
  kind: "writing",
  agentId: "reporter",
  displayName: "年报写作",
  version: "1.0.0",
  nextVersion: "1.2.1",
  runtime: "codex",
  instructions: "保留原文来源",
  capabilities: [{ name: "report.write", description: "撰写事实报告" }],
  resources: { skills: ["proof"] },
  inputFields: ["brief"],
  outputFields: ["article"],
  availablePackages: [
    { packageName: "reporter-v2", version: "2.0.0", displayName: "双语报告" },
  ],
};
afterEach(() => vi.restoreAllMocks());
function show() {
  const onPublished = vi.fn();
  render(
    <PackageUpgrade
      target={{ kind: "package", agentId: "reporter", version: "1.0.0" }}
      offline={false}
      onPublished={onPublished}
    />,
  );
  return onPublished;
}
it("publishes the edited writing instructions and retains the form after a conflict", async () => {
  vi.spyOn(factoryApi, "get").mockResolvedValue(source);
  const post = vi
    .spyOn(factoryApi, "post")
    .mockRejectedValueOnce(Error("版本号已使用"))
    .mockResolvedValue({
      agentId: "reporter",
      version: "1.2.2",
      status: "pending_review",
    });
  const done = show();
  const instructions = await screen.findByLabelText("业务流程与写作指令");
  expect(instructions).toHaveValue("保留原文来源");
  fireEvent.change(instructions, { target: { value: "按章节注明文献" } });
  fireEvent.click(screen.getByRole("button", { name: "发布新版本" }));
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(instructions).toHaveValue("按章节注明文献");
  fireEvent.change(screen.getByLabelText("目标发布版本"), {
    target: { value: "1.2.2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发布新版本" }));
  await waitFor(() => expect(done).toHaveBeenCalledWith("reporter", "1.2.2"));
  expect(post).toHaveBeenLastCalledWith("/v1/factory/releases", {
    intent: "upgrade",
    agentId: "reporter",
    baseVersion: "1.0.0",
    version: "1.2.2",
    displayName: "年报写作",
    capabilities: [{ name: "report.write", description: "撰写事实报告" }],
    instructions: "按章节注明文献",
  });
});
it("registers the selected installed implementation with its declared version", async () => {
  vi.spyOn(factoryApi, "get").mockResolvedValue({ ...source, kind: "package" });
  const post = vi.spyOn(factoryApi, "post").mockResolvedValue({
    agentId: "reporter",
    version: "2.0.0",
    status: "pending_review",
  });
  const done = show();
  fireEvent.change(await screen.findByLabelText("版本程序"), {
    target: { value: "reporter-v2" },
  });
  expect(screen.queryByLabelText("智能体名称")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "发布新版本" }));
  await waitFor(() => expect(done).toHaveBeenCalledWith("reporter", "2.0.0"));
  expect(post).toHaveBeenCalledWith("/v1/factory/releases", {
    intent: "upgrade",
    agentId: "reporter",
    packageName: "reporter-v2",
  });
});
