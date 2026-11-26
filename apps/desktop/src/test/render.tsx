import {
  render as renderTestingLibrary,
  type RenderOptions,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { FeedbackProvider } from "../components/FeedbackNotice";

export function render(ui: ReactElement, options?: RenderOptions) {
  return renderTestingLibrary(ui, { wrapper: FeedbackProvider, ...options });
}
