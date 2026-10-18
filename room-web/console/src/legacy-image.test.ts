import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { readFileSync } = await vi.importActual<{
  readFileSync(path: URL, encoding: "utf8"): string;
}>("node:fs");
const { Blob: NativeBlob, File: NativeFile } = await vi.importActual<{
  Blob: typeof Blob;
  File: typeof File;
}>("node:buffer");
const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto");
const fixturePath = "../../judge-room.html";
const html = readFileSync(new URL(fixturePath, import.meta.url), "utf8");
const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const jpeg = Uint8Array.of(255, 216, 255, 224);
const heic = Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99,
  0, 0, 0, 0, 109, 105, 102, 49, 104, 101, 105, 99);
let calls: { url: string; method: string; body: unknown }[];
let listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject }[] = [];
let originalUrlMethods: { key: string; descriptor?: PropertyDescriptor }[] = [];

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sent = () => calls.filter(call => call.url.includes("reference-image/") || call.url.endsWith("/submissions"));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  document.documentElement.innerHTML = html;
  sessionStorage.setItem("vdj-cloud:owner", JSON.stringify({
    owner: true, roomId: "synthetic-room", capability: "synthetic", autoGenerate: false,
  }));
  calls = [];
  listeners = [];
  originalUrlMethods = ["createObjectURL", "revokeObjectURL"].map(key => ({
    key, descriptor: Object.getOwnPropertyDescriptor(URL, key),
  }));
  for (const target of [window, document]) {
    const original = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      if (listener) listeners.push({ target, type, listener });
      original(type, listener, options);
    });
  }
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit = {}) => {
    calls.push({ url, method: options.method ?? "GET", body: options.body });
    return Response.json(url.includes("capabilities")
      ? { generation: true, cloud: { imageDirection: true } }
      : url.endsWith("/generation") ? { jobs: [] }
      : { accepting: true, controlRevision: 1, submissions: [], tracks: [], sets: [] });
  }));
});

afterEach(() => {
  for (const { target, type, listener } of listeners) target.removeEventListener(type, listener);
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const { key, descriptor } of originalUrlMethods) {
    if (descriptor) Object.defineProperty(URL, key, descriptor);
    else Reflect.deleteProperty(URL, key);
  }
  vi.useRealTimers();
});

function imageBrowser(width = 640, height = 480) {
  const decode = vi.fn(async () => ({ width, height, close() {} }));
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal("Image", class {
    naturalWidth = width;
    naturalHeight = height;
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true,
    value: vi.fn(() => "blob:synthetic-image") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback =>
    callback(new NativeBlob([new Uint8Array(16)], { type: "image/png" }) as unknown as Blob));
  return decode;
}

async function mount() {
  await import("../../judge-room.mjs");
  expect(element("error").textContent).toBe("");
  element<HTMLTextAreaElement>("prompt").value = "深い低音";
  calls = [];
}

async function choose(bytes: Uint8Array, type: string) {
  const input = element<HTMLInputElement>("reference-image");
  const file = new NativeFile([new Uint8Array(bytes)], "synthetic-photo", { type });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await input.onchange!.call(input, new Event("change"));
}

async function submit() {
  const form = element<HTMLFormElement>("prompt-form");
  await form.onsubmit!.call(form, new SubmitEvent("submit", { cancelable: true }));
}

describe("legacy room reference-image guard", () => {
  for (const kind of ["HEIC", "large JPEG"] as const) {
    it(`keeps rejected ${kind} local and requires removal before text submission`, async () => {
      if (kind === "large JPEG") imageBrowser(5712, 4284);
      else imageBrowser();
      await mount();
      await choose(kind === "HEIC" ? heic : jpeg, kind === "HEIC" ? "image/heic" : "image/jpeg");

      expect(element("error").textContent).toBe("");
      expect(element("image-status").textContent).not.toBe("");
      expect(element<HTMLButtonElement>("remove-image").hidden).toBe(false);
      expect(element<HTMLButtonElement>("submit").disabled).toBe(true);
      await submit();
      expect(sent()).toEqual([]);

      element<HTMLButtonElement>("remove-image").click();
      expect(element("image-status").textContent).toBe("");
      expect(element<HTMLButtonElement>("submit").disabled).toBe(false);
      await submit();
      expect(sent().map(call => [call.method, call.url])).toEqual([
        ["POST", "/api/rooms/synthetic-room/submissions"],
      ]);
      expect(element("error").textContent).toBe("");
    });
  }

  it("clears a pending selection and ignores its stale decode failure", async () => {
    const decode = imageBrowser();
    let rejectDecode!: (reason: Error) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    decode.mockImplementationOnce(() => {
      signalStarted();
      return new Promise((_resolve, reject) => { rejectDecode = reject; });
    });
    await mount();
    const pending = choose(png, "image/png");
    await started;
    expect(element<HTMLButtonElement>("submit").disabled).toBe(true);
    element<HTMLButtonElement>("remove-image").click();
    expect(element<HTMLButtonElement>("submit").disabled).toBe(false);
    rejectDecode(new Error("synthetic stale decode failure"));
    await pending;
    expect(element("error").textContent).toBe("");
    expect(element("image-status").textContent).toBe("");
    expect(element<HTMLButtonElement>("submit").disabled).toBe(false);
    await submit();
    expect(sent().map(call => call.url)).toEqual(["/api/rooms/synthetic-room/submissions"]);
  });
});
