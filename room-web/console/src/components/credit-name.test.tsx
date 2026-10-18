import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CreditName } from "./credit-name";

afterEach(cleanup);

it("shows only the complete name and updates when the credited creator changes", () => {
  const name = "オーナー👩‍🎨e\u0301と音楽";
  const view = render(<CreditName name={name} />);
  expect(screen.getByTitle(name).textContent).toBe(name);
  expect(view.container.textContent).toBe(name);
  expect(view.container.querySelector("[data-tone], [data-highlighted]")).toBeNull();
  view.rerender(<CreditName name="次の投稿者" />);
  expect(view.container.textContent).toBe("次の投稿者");
});

it("treats markup in a name as literal text", () => {
  const name = '<img src=x onerror="alert(1)">';
  const view = render(<CreditName name={name} />);
  expect(view.container.textContent).toBe(name);
  expect(view.container.querySelector("img")).toBeNull();
});
