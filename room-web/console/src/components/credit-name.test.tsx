import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditName } from "./credit-name";

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  vi.spyOn(window, "matchMedia").mockImplementation(() => ({
    matches: reducedMotion,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as MediaQueryList);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const letters = () => [...document.querySelectorAll(".stage-credit-letter")];
const highlighted = () => letters().flatMap((node, index) =>
  node.getAttribute("data-highlighted") === "true" ? [index] : []);
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("credit name animation", () => {
  it("moves a three-character highlight on a 50ms clock, refreshed every 64ms", () => {
    render(<CreditName name="ultrathink" />);
    expect(highlighted()).toEqual([]);
    advance(511);
    expect(highlighted()).toEqual([]);
    advance(1);
    expect(highlighted()).toEqual([0, 1]);
    advance(64);
    expect(highlighted()).toEqual([0, 1, 2]);
    advance(64);
    expect(highlighted()).toEqual([1, 2, 3]);
    advance(448);
    expect(highlighted()).toEqual([]);
    advance(960);
    expect(highlighted()).toEqual([0, 1]);
  });

  it("uses the shared page clock when a name appears later", () => {
    advance(600);
    render(<CreditName name="ultrathink" />);
    expect(highlighted()).toEqual([1, 2, 3]);
  });

  it("repeats the seven fixed colors and preserves complete graphemes", () => {
    const name = "オーナー👩‍🎨e\u0301と音楽";
    render(<CreditName name={name} />);
    expect(letters().map((node) => node.textContent)).toEqual([
      "オ", "ー", "ナ", "ー", "👩‍🎨", "e\u0301", "と", "音", "楽",
    ]);
    expect(letters().map((node) => node.getAttribute("data-tone"))).toEqual([
      "0", "1", "2", "3", "4", "5", "6", "0", "1",
    ]);
    expect(screen.getByTitle(name)).toBeTruthy();
    expect(screen.getByText(name, { selector: ".sr-only" })).toBeTruthy();
  });

  it("keeps the base colors still when reduced motion is requested", () => {
    reducedMotion = true;
    render(<CreditName name="オーナー" />);
    advance(550);
    expect(highlighted()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the animation timer on unmount", () => {
    const view = render(<CreditName name="オーナー" />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
