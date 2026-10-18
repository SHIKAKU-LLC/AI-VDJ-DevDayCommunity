import React from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./theme";
import { TooltipProvider } from "./components/ui/tooltip";
import { readDisplayRoute } from "../../judge-display.mjs";
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
const root = createRoot(document.getElementById("root")!);
const display = readDisplayRoute(location, sessionStorage, history);
if (display) {
  // Do not import the owner controller or read its stored credentials here.
  void import('./DisplayScreen').then(({DisplayScreen}) => root.render(<DisplayScreen id={display.id} />));
} else void import('./App').then(({App}) => root.render(
  <ThemeProvider>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </ThemeProvider>,
));
