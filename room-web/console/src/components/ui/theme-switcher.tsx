"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { cn } from "cn";
import { useTheme } from "@/theme";
import { useSyncExternalStore } from "react";

const subscribeToHydration = () => () => {
  // The snapshot changes only once, when React finishes hydrating.
};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

const THEMES = [
  { Icon: SunIcon, label: "ライト", value: "light" },
  { Icon: MonitorIcon, label: "システム", value: "system" },
  { Icon: MoonIcon, label: "ダーク", value: "dark" },
] as const;

export interface ThemeSwitcherProps {
  className?: string;
  size?: "default" | "sm";
  disabled?: boolean;
}

/**
 * The canonical Light / System / Dark control. Reads from and writes to
 * `next-themes`; place it once per app rather than mirroring its state.
 */
const ThemeSwitcher = ({
  className,
  size = "default",
  disabled = false,
}: ThemeSwitcherProps) => {
  const { theme = "system", setTheme } = useTheme();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    clientSnapshot,
    serverSnapshot
  );
  const selectedTheme = hydrated ? theme : "system";

  return (
    <div
      aria-label="テーマ"
      className={cn(
        "surface-inset border-border/60 inline-flex items-center gap-0.5 rounded-2xl border p-1",
        className
      )}
      data-size={size}
      data-slot="theme-switcher"
      role="radiogroup"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          disabled ||
          ![
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
          ].includes(event.key)
        ) {
          return;
        }
        event.preventDefault();
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
        ];
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        const backwards = event.key === "ArrowLeft" || event.key === "ArrowUp";
        let next =
          (current + (backwards ? -1 : 1) + THEMES.length) % THEMES.length;
        if (event.key === "Home") {
          next = 0;
        }
        if (event.key === "End") {
          next = THEMES.length - 1;
        }
        const nextTheme = THEMES[next];
        if (nextTheme) {
          setTheme(nextTheme.value);
          buttons[next]?.focus();
        }
      }}
    >
      {THEMES.map(({ Icon, label, value }) => {
        const selected = selectedTheme === value;
        return (
          <button
            aria-checked={selected}
            aria-label={label}
            className={cn(
              "text-muted-foreground hover:text-foreground focus-visible:ring-ring/30 data-[selected=true]:bg-card data-[selected=true]:surface-raised data-[selected=true]:text-foreground inline-flex items-center justify-center rounded-xl transition-colors duration-150 outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 data-[selected=true]:shadow-sm motion-reduce:transition-none [&_svg]:pointer-events-none",
              size === "sm"
                ? "size-6 [&_svg]:size-3.5"
                : "size-8 [&_svg]:size-4"
            )}
            data-selected={selected}
            data-slot="theme-switcher-item"
            disabled={disabled}
            key={value}
            onClick={() => setTheme(value)}
            role="radio"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            <Icon aria-hidden />
          </button>
        );
      })}
    </div>
  );
};

export { ThemeSwitcher };
