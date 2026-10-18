import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
const { Blob: NativeBlob, File: NativeFile } = await vi.importActual<{
  Blob: typeof Blob; File: typeof File;
}>("node:buffer");
const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto");
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
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body ?? null;
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
  vi.restoreAllMocks();
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

// Browser image APIs are the external boundary; attachment admission and the
// controller's request/state behavior run unchanged in these tests.
function imageBrowser() {
  let width = 640, height = 480, decodeFails = false;
  type Bitmap = { width: number; height: number; close(): void };
  let nextDecode: Promise<Bitmap> | undefined;
  const replacements = [
    [globalThis, "createImageBitmap"], [globalThis, "crypto"], [globalThis, "Image"],
    [URL, "createObjectURL"], [URL, "revokeObjectURL"],
  ] as const;
  const originals = replacements.map(([target, key]) =>
    [target, key, Object.getOwnPropertyDescriptor(target, key)] as const);
  onTestFinished(() => {
    for (const [target, key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  });
  const decode = vi.fn(async () => {
    if (nextDecode) {
      const pending = nextDecode;
      nextDecode = undefined;
      return pending;
    }
    if (decodeFails) throw new DOMException("Synthetic decode failure", "InvalidStateError");
    return { width, height, close() {} };
  });
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
  Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
    onerror?: () => void;
    set src(_value: string) { Promise.resolve().then(() => this.onerror?.()); }
  } });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:synthetic-image" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
    callback(new NativeBlob([new Uint8Array(16)], { type: "image/png" }) as unknown as Blob));
  return {
    decode,
    dimensions(w: number, h: number) { width = w; height = h; },
    failDecode() { decodeFails = true; },
    deferNextDecode() {
      let release!: (bitmap: Bitmap) => void;
      nextDecode = new Promise(resolve => { release = resolve; });
      return () => release({ width, height, close() {} });
    },
  };
}

const photo = (type = "image/png") => new NativeFile([
  type === "image/heic"
    ? new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0, 109, 105, 102, 49, 104, 101, 105, 99])
    : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
], "synthetic", { type });

async function mountOpenRoom() {
  const controller = await mount();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "ルームを開く" })));
  calls = [];
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
    expect(screen.getByRole("button", {name: "別タブで大画面を開く"})).toBeTruthy();
    expect(document.body.textContent).not.toContain("このアイデアから生まれました");
    const requestFullscreen = vi.fn(async () => {});
    document.getElementById("stage")!.requestFullscreen = requestFullscreen;
    await act(async () =>
      fireEvent.keyDown(screen.getByRole("button", { name: "再生する" }), {
        key: "f",
      }),
    );
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    await act(async () =>
      fireEvent.keyDown(screen.getByLabelText("音楽と映像のイメージ"), {
        key: "f",
      }),
    );
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
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
  for (const reason of ["unsupported format", "oversized dimensions", "decode failure"]) {
    it(`keeps ${reason} local and blocks server submission until the image is removed`, async () => {
      const browser = imageBrowser();
      const controller = await mountOpenRoom();
      if (reason === "oversized dimensions") browser.dimensions(5712, 4284);
      if (reason === "decode failure") browser.failDecode();
      const selected = photo(reason === "unsupported format" ? "image/heic" : "image/png");
      await act(async () => controller.attach(selected));
      const state = controller.getSnapshot();
      expect(state.image).toBeNull();
      expect(state.error).toBe("");
      expect(state.imageNotice).toMatch(/JPEG.*PNG.*WebP/);
      expect(state.imageNotice).toMatch(/選び直|外し|外す|取り除/);
      expect(screen.getByText(state.imageNotice)).toBeTruthy();
      expect(state.jobs).toEqual([]);
      expect(calls).toEqual([]);
      if (reason === "unsupported format") expect(browser.decode).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText("音楽と映像のイメージ"), {
        target: { value: "写真に合わせた音楽" },
      });
      await act(async () => fireEvent.submit(document.querySelector("form")!));
      expect(calls).toEqual([]);
      expect((screen.getByLabelText("音楽と映像のイメージ") as HTMLTextAreaElement).value)
        .toBe("写真に合わせた音楽");
      expect(controller.getSnapshot().jobs).toEqual([]);

      await act(async () => controller.clearReference());
      expect(controller.getSnapshot().imageNotice).toBe("");
      await act(async () => fireEvent.submit(document.querySelector("form")!));
      expect(calls.filter(call => call.url.endsWith("/submissions"))).toHaveLength(1);
      expect(calls.some(call => call.url.includes("reference-image"))).toBe(false);
      expect((screen.getByLabelText("音楽と映像のイメージ") as HTMLTextAreaElement).value).toBe("");
    });
  }
  it("clears a previous attachment after rejection and only uploads a valid replacement", async () => {
    imageBrowser();
    const controller = await mountOpenRoom();
    await act(async () => controller.attach(photo()));
    expect(controller.getSnapshot().image).not.toBeNull();
    await act(async () => controller.attach(photo("image/heic")));
    expect(controller.getSnapshot().image).toBeNull();
    expect(controller.getSnapshot().error).toBe("");
    expect(controller.getSnapshot().imageNotice).toMatch(/JPEG.*PNG.*WebP/);
    let submitted;
    await act(async () => { submitted = await controller.submit("写真に合わせた音楽"); });
    expect(submitted).toBe(false);
    expect(calls).toEqual([]);

    await act(async () => controller.attach(photo()));
    expect(controller.getSnapshot().imageNotice).toBe("");
    expect(controller.getSnapshot().image).not.toBeNull();
    await act(async () => { submitted = await controller.submit("写真に合わせた音楽"); });
    expect(submitted).toBe(true);
    const uploads = calls.filter(call => call.url.includes("reference-image"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].body.type).toBe("image/png");
    expect(calls.filter(call => call.url.endsWith("/submissions"))).toHaveLength(1);
    expect(controller.getSnapshot().error).toBe("");
  });
  it("keeps a replacement rejection active when an earlier image finishes decoding", async () => {
    const browser = imageBrowser();
    const controller = await mountOpenRoom();
    const finishDecode = browser.deferNextDecode();
    let pending: Promise<void>;
    act(() => { pending = controller.attach(photo()); });
    expect(controller.getSnapshot().imageBusy).toBe(true);
    await act(async () => controller.attach(photo("image/heic")));
    const notice = controller.getSnapshot().imageNotice;
    expect(notice).toMatch(/JPEG.*PNG.*WebP/);
    await act(async () => { finishDecode(); await pending; });
    expect(controller.getSnapshot().image).toBeNull();
    expect(controller.getSnapshot().imageNotice).toBe(notice);
    expect(controller.getSnapshot().imageBusy).toBe(false);
    expect(controller.getSnapshot().error).toBe("");
    let submitted;
    await act(async () => { submitted = await controller.submit("写真に合わせた音楽"); });
    expect(submitted).toBe(false);
    expect(calls).toEqual([]);
  });
  it("recovers entry capabilities without a room after a temporary failure", async () => {
    const available = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "NETWORK_FAILED" }, { status: 503 }),
      ),
    );
    await mount();
    expect(
      (
        screen.getByRole("button", {
          name: "ルームを開く",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    vi.stubGlobal("fetch", available);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "状態を再確認" })),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "ルームを開く",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe("");
  });
});
