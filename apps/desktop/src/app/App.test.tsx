import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "../App";

describe("App", () => {
  it("renders the Qizhi product name", () => {
    render(<App />);

    expect(screen.getByText("栖知")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation")[0]).toHaveTextContent("今日");
    expect(screen.getAllByRole("navigation")[0]).toHaveTextContent("知识库");
    expect(screen.getAllByRole("navigation")[0]).toHaveTextContent(
      "Codex 工作",
    );
    expect(screen.getAllByRole("navigation")[0]).toHaveTextContent("设置");
  });
});
