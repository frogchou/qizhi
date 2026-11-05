import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppSidebar } from "./AppSidebar";

describe("AppSidebar brand", () => {
  it("renders_the_leaf_brand_mark_without_a_letter_placeholder", () => {
    const { container } = render(
      <AppSidebar active="today" onNavigate={() => undefined} />,
    );

    expect(container.querySelector("svg.brand-logo")).toBeInTheDocument();
    expect(container.querySelector(".brand-mark")).not.toBeInTheDocument();
    expect(screen.queryByText("Q")).not.toBeInTheDocument();
    expect(screen.getByText("栖知")).toBeInTheDocument();
  });
});
