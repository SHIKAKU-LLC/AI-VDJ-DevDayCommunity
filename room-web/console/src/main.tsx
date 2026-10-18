import React from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./theme";
import { TooltipProvider } from "./components/ui/tooltip";
import { App } from "./App";
import "./styles.css";
// The class is applied before the first paint; no inline script or remote fonts.
try {
  document.documentElement.classList.toggle(
    "dark",
    (localStorage.getItem("vdj-theme") ?? "dark") === "dark" ||
      (localStorage.getItem("vdj-theme") === "system" &&
        matchMedia("(prefers-color-scheme:dark)").matches),
  );
} catch {
  /* default dark */
}
createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </ThemeProvider>,
);
