import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
const ThemeContext = createContext({
  theme: "dark",
  setTheme: (_theme: string) => {},
});
// Keep the registry switcher while avoiding next-themes' inline bootstrap
// script: the application's CSP intentionally permits only self-hosted scripts.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("vdj-theme") ?? "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme:dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      );
    apply();
    try {
      localStorage.setItem("vdj-theme", theme);
    } catch {
      /* storage is optional */
    }
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
export const useTheme = () => useContext(ThemeContext);
