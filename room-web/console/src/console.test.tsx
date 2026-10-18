import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { App } from "./App";
import { ThemeProvider } from "./theme";
import { TooltipProvider } from "./components/ui/tooltip";
import { createRoomController } from "../../judge-controller.mjs";
const capabilities = { generation: true, cloud: { imageDirection: true } };
let calls: { url: string; body: any }[] = [];
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  calls = [];
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: any = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, body });
      return Response.json(
        url.includes("capabilities")
          ? capabilities
          : url === "/api/judge/rooms"
            ? {
                roomId: "fixture",
                ownerToken: "synthetic",
                joinUrl: "http://localhost/join/fixture",
              }
            : url.endsWith("/generation")
              ? { jobs: [] }
              : { accepting: true, controlRevision: 1, submissions: [] },
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function mount() {
  const controller = createRoomController();
  await act(async () => {
    render(
      <ThemeProvider>
        <TooltipProvider>
          <App controller={controller} />
        </TooltipProvider>
      </ThemeProvider>,
    );
  });
  return controller;
}
describe("console and stable runtime", () => {
  it("creates once, keeps stage nodes on theme and panel changes, and preserves mute transport independence", async () => {
    const controller = await mount();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ルームを開く" }));
      fireEvent.click(screen.getByRole("button", { name: "ルームを開く" }));
    });
    expect(calls.filter((c) => c.url === "/api/judge/rooms")).toHaveLength(1);
    const video = document.getElementById("videos"),
      canvas = document.getElementById("vj-overlay");
    fireEvent.click(screen.getByRole("radio", { name: "ライト" }));
    fireEvent.click(screen.getByRole("button", { name: "アイデアを投稿" }));
    expect(document.getElementById("videos")).toBe(video);
    expect(document.getElementById("vj-overlay")).toBe(canvas);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    act(() => controller.setOutput(-6, true));
    expect(controller.getSnapshot().muted).toBe(true);
    expect(controller.getSnapshot().gainDb).toBe(-6);
    expect(
      screen
        .getByRole("button", { name: "ミュートを解除" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it("submits a short text without image, prevents duplicates, and clears only on success", async () => {
    const controller = await mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "ルームを開く" })),
    );
    fireEvent.change(screen.getByLabelText("音楽と映像のイメージ"), {
      target: { value: "深い低音" },
    });
    await act(async () => {
      fireEvent.submit(document.querySelector("form")!);
      fireEvent.submit(document.querySelector("form")!);
    });
    const sent = calls.filter((c) => c.url.endsWith("/submissions"));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.prompt).toBe("深い低音");
    expect(calls.some((c) => c.url.includes("reference-image"))).toBe(false);
    expect(
      (screen.getByLabelText("音楽と映像のイメージ") as HTMLTextAreaElement)
        .value,
    ).toBe("");
    expect(controller.getSnapshot().status).toContain("受付完了");
  });
  it("retains failed input and reports the error for retry", async () => {
    await mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "ルームを開く" })),
    );
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: any) =>
        url.endsWith("/submissions")
          ? Response.json({ error: "RATE_LIMITED" }, { status: 429 })
          : original(url, options),
      ),
    );
    fireEvent.change(screen.getByLabelText("音楽と映像のイメージ"), {
      target: { value: "再試行する音" },
    });
    await act(async () => fireEvent.submit(document.querySelector("form")!));
    expect(screen.getByRole("alert").textContent).toContain("少し時間をおいて");
    expect(
      (screen.getByLabelText("音楽と映像のイメージ") as HTMLTextAreaElement)
        .value,
    ).toBe("再試行する音");
  });
});
