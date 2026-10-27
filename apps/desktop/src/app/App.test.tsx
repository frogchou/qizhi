import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "../App";

describe("App", () => {
  it("renders the Qizhi product name", () => {
    render(<App />);

    expect(screen.getByText("栖知")).toBeInTheDocument();
  });
});
