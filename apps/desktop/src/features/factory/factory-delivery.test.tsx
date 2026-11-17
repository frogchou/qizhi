import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactoryTaskDetail } from "./FactoryTaskDetail";
import { factoryApi } from "./factory-client";
import type { TaskDetail, TaskNode } from "./factory-model";

const timestamp = "2026-11-16T02:00:00Z";
function node(
  key: string,
  output: Record<string, unknown>,
  plan = "plan-2",
): TaskNode {
  return {
    id: key + "-" + plan,
    plan_id: plan,
    node_key: key,
    display_title: key === "analysis" ? "两份 README 分析" : key,
    capability:
      key === "analysis" ? "quality.define_and_verify" : "text.generate",
    state: "succeeded",
    output: { output },
  };
}
function artifact(
  id: string,
  fileName: string,
  taskNodeId = "analysis-plan-2",
) {
  return {
    id,
    fileName,
    taskNodeId,
    mediaType: "application/json",
    revision: 1,
    sizeBytes: 1024,
    sha256: "a".repeat(64),
    createdAt: timestamp,
  };
}
function detail(): TaskDetail {
  return {
    task: {
      id: "readme-analysis",
      goal: "分析两份 README",
      state: "accepted",
      acceptance_mode: "human_review",
      created_at: timestamp,
      updated_at: timestamp,
      current_plan_version: 2,
      revision_number: 1,
    },
    planSummary: null,
    plans: [
      {
        id: "plan-2",
        version: 2,
        state: "compiled",
        created_at: timestamp,
        plan: {},
      },
      {
        id: "plan-1",
        version: 1,
        state: "compiled",
        created_at: timestamp,
        plan: {},
      },
    ],
    nodes: [],
    artifacts: [],
    acceptanceRounds: [],
    attempts: [],
    activities: [],
  };
}
function show(value: TaskDetail) {
  return render(
    <FactoryTaskDetail
      detail={value}
      tab="delivery"
      onTab={() => undefined}
      onAgent={() => undefined}
      onChange={() => undefined}
      refreshTask={() => undefined}
      stale={false}
    />,
  );
}
function round(id: string, revision: number, number: number, answer: string) {
  return {
    id,
    revision_number: revision,
    round: number,
    decision: null,
    created_at: timestamp,
    decided_at: null,
    criteria: [],
    assessment: { deliveries: [{ node: "analysis", answer }] },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("factory delivery", () => {
  it("shows both README analyses from legacy findings before process reports", () => {
    const value = detail();
    value.nodes = [
      node("analysis", {
        summary: "已完成质检并生成验收记录。",
        status: "completed",
        findings: [
          {
            id: "readme-cn",
            message:
              "## README.md\n\n中文说明覆盖安装流程。\n\n- 缺少部署前置条件。",
          },
          {
            id: "readme-en",
            message:
              "## README_EN.md\n\n英文说明缺少环境变量示例。\n\n1. 补充 API 地址。\n2. 对齐启动命令。",
          },
        ],
      }),
    ];
    value.artifacts = [
      artifact("criteria", "acceptance-criteria.json"),
      artifact("assessment", "quality-assessment.json"),
    ];
    const { container } = show(value);
    expect(screen.getByRole("heading", { name: "README.md" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "README_EN.md" })).toBeVisible();
    expect(screen.getByText("缺少部署前置条件。").closest("li")).not.toBeNull();
    expect(
      screen.queryByText("已完成质检并生成验收记录。"),
    ).not.toBeInTheDocument();
    const records = screen.getByText(/执行与质检记录/).closest("details");
    expect(records).not.toHaveAttribute("open");
    expect(
      within(records!).getByRole("button", {
        name: "下载 acceptance-criteria.json",
        hidden: true,
      }),
    ).toBeInTheDocument();
    expect(container.textContent!.indexOf("README.md")).toBeLessThan(
      container.textContent!.indexOf("acceptance-criteria.json"),
    );
  });

  it("keeps the complete node answer over a shortened assessment and copies the full content", async () => {
    const body =
      "## 完整分析\n\n" +
      "逐项分析与建议。".repeat(700) +
      "\n\n正文末尾的最终结论。";
    const value = detail();
    value.nodes = [
      node("analysis", { answer: body, text: "较短文字", summary: "过程摘要" }),
    ];
    value.acceptanceRounds = [round("latest", 1, 2, body.slice(0, 4200))];
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container } = show(value);
    expect(container.textContent).toContain("正文末尾的最终结论。");
    expect(container.textContent).not.toContain("较短文字");
    expect(container.textContent).not.toContain("过程摘要");
    expect(screen.getAllByRole("heading", { name: "完整分析" })).toHaveLength(
      1,
    );
    fireEvent.click(screen.getByRole("button", { name: "复制完整成果" }));
    expect(await screen.findByText("已复制完整成果")).toBeVisible();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(body));
  });

  it("uses only current-plan nodes and current-revision assessment answers", () => {
    const value = detail();
    value.nodes = [
      node("analysis", { summary: "本次摘要" }),
      node("analysis", { answer: "旧计划正文" }, "plan-1"),
    ];
    value.acceptanceRounds = [
      round("old", 0, 20, "旧修订验收正文"),
      round("current", 1, 2, "本次完整分析"),
    ];
    show(value);
    expect(screen.getByText("本次完整分析")).toBeVisible();
    expect(screen.queryByText("旧计划正文")).not.toBeInTheDocument();
    expect(screen.queryByText("旧修订验收正文")).not.toBeInTheDocument();
    expect(screen.queryByText("本次摘要")).not.toBeInTheDocument();
  });

  it("does not revive the previous plan while a new revision is being planned", () => {
    const value = detail();
    value.task.state = "planning";
    value.task.current_plan_version = 1;
    value.revisions = [
      {
        id: "revision-1",
        revisionNumber: 1,
        decision: "amend",
        message: "补充分析",
        inputIds: [],
        reviewId: "old",
        planVersion: null,
        createdAt: timestamp,
      },
    ];
    value.nodes = [node("analysis", { answer: "上一版分析" }, "plan-1")];
    value.planSummary = { mode: "direct_answer", summary: "上一版直接答复" };
    show(value);
    expect(screen.queryByText("上一版分析")).not.toBeInTheDocument();
    expect(screen.queryByText("上一版直接答复")).not.toBeInTheDocument();
  });

  it("honors authoritative empty delivery without falling back to stale output", () => {
    const value = Object.assign(detail(), {
      delivery: {
        revisionNumber: 1,
        answers: [],
        artifactIds: [],
        supportingArtifactIds: [],
      },
    });
    value.nodes = [node("analysis", { answer: "不应回填的旧正文" })];
    value.artifacts = [artifact("old-file", "old.json")];
    value.acceptanceRounds = [round("latest", 1, 2, "不应回填的旧验收摘要")];
    show(value);
    expect(screen.queryByText("不应回填的旧正文")).not.toBeInTheDocument();
    expect(screen.queryByText("不应回填的旧验收摘要")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "下载 old.json" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("本次修订尚无可展示的成果")).toBeVisible();
  });

  it("keeps explicit PPT and JSON deliverables downloadable and process files collapsed", async () => {
    const value = Object.assign(detail(), {
      delivery: {
        revisionNumber: 1,
        answers: [
          {
            nodeKey: "analysis",
            title: "分析结果",
            body: "## 两份文件的结论\n\n正文可直接阅读。",
            format: "markdown" as const,
          },
        ],
        artifactIds: ["ppt", "json"],
        supportingArtifactIds: ["criteria"],
      },
    });
    value.artifacts = [
      artifact("criteria", "acceptance-criteria.json"),
      artifact("ppt", "汇报.pptx"),
      artifact("json", "requested-data.json"),
      artifact("old", "旧版.pptx"),
    ];
    const download = vi.spyOn(factoryApi, "download").mockResolvedValue(true);
    show(value);
    expect(
      screen.getByRole("heading", { name: "两份文件的结论" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "下载 汇报.pptx" }),
    ).toBeVisible();
    const json = screen.getByRole("button", {
      name: "下载 requested-data.json",
    });
    expect(json.closest("details")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "下载 旧版.pptx" }),
    ).not.toBeInTheDocument();
    fireEvent.click(json);
    expect(await screen.findByText("已保存 requested-data.json")).toBeVisible();
    expect(download).toHaveBeenCalledWith(
      "readme-analysis",
      "json",
      "requested-data.json",
    );
  });

  it("uses Markdown headings, paragraphs and safe links without injecting HTML", () => {
    const value = Object.assign(detail(), {
      delivery: {
        revisionNumber: 1,
        answers: [
          {
            nodeKey: "analysis",
            title: "分析结果",
            format: "markdown" as const,
            body: '## 文件结论\n\n第一段。\n\n第二段。\n\n[安全来源](https://example.com/readme)\n\n[危险链接](javascript:alert(1))\n\n<script>alert("xss")</script>\n\n<img src=x onerror=alert(1)>',
          },
        ],
        artifactIds: [],
        supportingArtifactIds: [],
      },
    });
    const { container } = show(value);
    expect(screen.getByRole("heading", { name: "文件结论" })).toBeVisible();
    expect(screen.getByText("第二段。").tagName).toBe("P");
    const link = screen.getByRole("link", { name: "安全来源" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
    expect(
      container.querySelector('script, img, [onerror], a[href^="javascript:"]'),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "危险链接" }),
    ).not.toBeInTheDocument();
  });

  it("shows the final producer instead of consumed retrieval notes and verification findings", () => {
    const value = detail();
    value.nodes = [
      {
        ...node("retrieve", { text: "检索过程中的内部说明" }),
        capability: "knowledge.retrieve",
      },
      {
        ...node("writer", { answer: "交付给用户的最终分析" }),
        depends_on: ["retrieve"],
      },
      {
        ...node("analysis", {
          findings: [{ message: "复核结果仅作质检记录" }],
        }),
        depends_on: ["writer"],
      },
    ];
    show(value);
    expect(screen.getByText("交付给用户的最终分析")).toBeVisible();
    expect(screen.queryByText("检索过程中的内部说明")).not.toBeInTheDocument();
    expect(screen.queryByText("复核结果仅作质检记录")).not.toBeInTheDocument();
  });

  it("preserves parallel leaf answers", () => {
    const value = detail();
    value.nodes = [
      {
        ...node("retrieve", { text: "共同检索笔记" }),
        capability: "knowledge.retrieve",
      },
      {
        ...node("cn", { answer: "中文文件的最终结论" }),
        depends_on: ["retrieve"],
      },
      {
        ...node("en", { answer: "英文文件的最终结论" }),
        depends_on: ["retrieve"],
      },
    ];
    show(value);
    expect(screen.getByText("中文文件的最终结论")).toBeVisible();
    expect(screen.getByText("英文文件的最终结论")).toBeVisible();
    expect(screen.queryByText("共同检索笔记")).not.toBeInTheDocument();
  });

  it("keeps quality-only analysis when its upstream retrieval has text", () => {
    const value = detail();
    value.nodes = [
      {
        ...node("retrieve", { text: "读取资料的过程说明" }),
        capability: "knowledge.retrieve",
      },
      {
        ...node("analysis", {
          findings: [{ message: "两份 README 的实质分析" }],
        }),
        depends_on: ["retrieve"],
      },
    ];
    show(value);
    expect(screen.getByText("两份 README 的实质分析")).toBeVisible();
    expect(screen.queryByText("读取资料的过程说明")).not.toBeInTheDocument();
  });
  it("preserves text-format content literally", () => {
    const value = Object.assign(detail(), {
      delivery: {
        revisionNumber: 1,
        answers: [
          {
            nodeKey: "analysis",
            title: "正文",
            body: "# 原样文本\n\n**不转换**",
            format: "text" as const,
          },
        ],
        artifactIds: [],
        supportingArtifactIds: [],
      },
    });
    show(value);
    expect(screen.getByText(/# 原样文本/)).toHaveTextContent("**不转换**");
    expect(
      screen.queryByRole("heading", { name: "原样文本" }),
    ).not.toBeInTheDocument();
  });
});
