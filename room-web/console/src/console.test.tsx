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
import { REFERENCE_IMAGE_ACCEPT } from "../../judge-image.mjs";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    expect((screen.getByRole("button", {name:"再生する"}) as HTMLButtonElement).disabled).toBe(false);
    const invite = screen.getByRole("button", {name:"みんなを招待・受付設定"});
    expect(invite.closest("header")).not.toBeNull();
    expect(invite.compareDocumentPosition(screen.getByRole("radio", {name:"ライト"})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  it("lists file extensions and rejects an unsupported image before upload or generation", async () => {
    const controller = await mount();
    await act(async () => fireEvent.click(screen.getByRole("button", {name:"ルームを開く"})));
    const picker = screen.getByLabelText("参考画像（任意）") as HTMLInputElement;
    expect(picker.accept).toBe(REFERENCE_IMAGE_ACCEPT);
    expect(document.getElementById("image-help")!.textContent).toContain(".jpg・.jpeg・.png・.webp・.heic・.heif");
    expect(document.getElementById("image-help")!.textContent).toContain("対応ブラウザのみ");
    fireEvent.change(screen.getByLabelText("音楽と映像のイメージ"), {target:{value:"深い低音"}});
    await act(async () => controller.attach(new File(["GIF89a"], "synthetic.gif", {type:"image/gif"})));
    expect(screen.getByRole("alert").textContent).toContain(".jpg・.jpeg");
    expect((screen.getByRole("button", {name:"音楽・映像を生成する"}) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.submit(document.querySelector("form")!));
    expect(calls.some(c=>c.url.includes("reference-image") || c.url.endsWith("/submissions"))).toBe(false);
    expect(controller.getSnapshot().image).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", {name:"画像なしで続ける"})));
    expect(controller.getSnapshot().imageError).toBe(false);
    await act(async () => fireEvent.submit(document.querySelector("form")!));
    expect(calls.filter(c=>c.url.endsWith("/submissions"))).toHaveLength(1);
    expect(calls.some(c=>c.url.includes("reference-image"))).toBe(false);
  });
  it("distinguishes an image-analysis failure from an unsupported file format", async () => {
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url:string, options:any) =>
      url.endsWith("/generation") ? Response.json({jobs:[{id:"image-job",state:"FAILED",reason:"IMAGE_DIRECTION_INVALID"}]}) :
      url.startsWith("/api/rooms/") ? Response.json({accepting:true,controlRevision:1,submissions:[{submissionId:"image-job",nickname:"合成テスト",prompt:"深い低音"}]}) : original(url,options)));
    await mount();
    await act(async () => fireEvent.click(screen.getByRole("button", {name:"ルームを開く"})));
    expect(screen.getByText("画像は読み込めましたが、演出の解析結果を処理できませんでした。再試行してください。")).toBeTruthy();
    expect(screen.getByRole("button",{name:"生成済み素材の確認を再試行"})).toBeTruthy();
  });
  it("accepts a readable JPEG after rejection, uploading only one normalised PNG", async () => {
    const {Blob:NodeBlob, File:NodeFile} = await vi.importActual<{Blob:typeof Blob;File:typeof File}>("node:buffer");
    const controller = await mount();
    await act(async () => fireEvent.click(screen.getByRole("button", {name:"ルームを開く"})));
    await act(async () => controller.attach(new NodeFile(["GIF89a"], "synthetic.gif")));
    vi.stubGlobal("createImageBitmap", async () => ({width:64,height:64,close:vi.fn()}));
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:synthetic-image"; }
      static revokeObjectURL() {}
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({drawImage:vi.fn()} as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback =>
      callback(new NodeBlob(["normalised-png"], {type:"image/png"}) as unknown as Blob));
    let uploads = 0;
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url:string, options:any) => {
      if (!url.includes("reference-image")) return original(url, options);
      uploads++;
      expect(options.body.type).toBe("image/png");
      expect(options.headers["content-type"]).toBe("image/png");
      expect(options.headers["x-vdj-prompt-sha256"]).toMatch(/^[a-f0-9]{64}$/);
      return Response.json({});
    }));
    await act(async () => controller.attach(new NodeFile([new Uint8Array([255,216,255,224])], "synthetic.jpeg")));
    expect(controller.getSnapshot().imageError).toBe(false);
    expect(screen.getByText("synthetic.jpeg")).toBeTruthy();
    expect(uploads).toBe(0);
    await act(async () => { await controller.submit("深い低音"); });
    expect(uploads).toBe(1);
    expect(calls.filter(c=>c.url.endsWith("/submissions"))).toHaveLength(1);
    expect(controller.getSnapshot().image).toBeNull();
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
