import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { ResourceChoices } from "./AssemblyChoices";
import type { AssemblyOptions, ResourceSelection } from "./assembly-model";

it("keeps existing grants visible when the catalog is unavailable and never grants a suggestion on expansion", () => {
  const options: AssemblyOptions = {
    skills: [
      { id: "writing@1", label: "撰稿", version: "1" },
      { id: "editing@1", label: "校对", version: "1" },
    ],
    mcpTools: [],
    capabilities: [],
    datasets: [],
    connection: { status: "unavailable", message: "知识库连接暂时中断" },
  };
  function Editor() {
    const [selection, setSelection] = useState<ResourceSelection>({
      skills: ["editing@1"],
      mcpTools: [],
      capabilities: [],
      datasetIds: ["采购资料"],
    });
    return (
      <ResourceChoices
        options={options}
        selection={selection}
        suggestions={{ skills: ["writing@1"] }}
        collapsible
        onEdit={(field, value) =>
          setSelection((old) => ({ ...old, [field]: value }))
        }
      />
    );
  }
  render(<Editor />);
  const kb = screen.getByRole("button", { name: /RAGFlow 知识库/ });
  const skills = screen.getByRole("button", { name: /精选 Skill/ });
  expect(kb).toHaveTextContent("含不可用资源");
  expect(kb).toHaveTextContent("采购资料");
  expect(kb).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("知识库连接暂时中断")).toBeVisible();
  expect(skills).toHaveTextContent("1 项建议");
  expect(skills).toHaveTextContent("已选 1");
  fireEvent.click(skills);
  expect(screen.getByRole("checkbox", { name: /撰稿/ })).not.toBeChecked();
  fireEvent.click(kb);
  expect(skills).toHaveAttribute("aria-expanded", "true");
  const datasets = screen.getByRole("group", { name: "RAGFlow 知识库" });
  const missing = within(datasets).getByRole("checkbox", { name: /采购资料/ });
  expect(missing).toBeChecked();
  fireEvent.click(missing);
  expect(
    within(datasets).queryByRole("checkbox", { name: /采购资料/ }),
  ).toBeNull();
  fireEvent.click(kb);
  expect(kb).toHaveTextContent("不用知识库");
});
