import { vi } from "vitest";
import { stubTool } from "./fast-tool-stubs.js";

vi.mock("../tools/browser-tool.js", () => ({
  createBrowserTool: () => stubTool("browser"),
}));

vi.mock("../tools/canvas-tool.js", () => ({
  createCanvasTool: () => stubTool("canvas"),
}));

vi.mock("../tools/web-tools.js", () => ({
  createWebFetchTool: () => stubTool("web_fetch"),
  createWebSearchTool: () => stubTool("web_search"),
  createWebResearchTool: () => stubTool("web_research"),
}));
