"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "cn";
import type { ComponentProps } from "react";

export type ProgressTone = "ok" | "warn" | "clip";

const TONE_CLASS: Record<ProgressTone, string> = {
  clip: "bg-meter-clip",
  ok: "bg-meter-ok",
  warn: "bg-meter-warn",
};

/** Segment position thresholds, as a percentage of the track, where the LED
 * ladder shifts zone. Mirrors the level meter's ok → warn → clip language. */
const ZONE_THRESHOLDS = { clip: 90, warn: 70 };

const zoneForPercent = (percent: number): ProgressTone => {
  if (percent >= ZONE_THRESHOLDS.clip) {
    return "clip";
  }
  if (percent >= ZONE_THRESHOLDS.warn) {
    return "warn";
  }
  return "ok";
};

export interface ProgressProps extends Omit<
  ProgressPrimitive.Root.Props,
  "children"
> {
  /** `meter` renders a segmented LED ladder instead of a solid bar. Default `bar`. */
  variant?: "bar" | "meter";
  /** Segments for the `meter` variant. Default 20. */
  segments?: number;
  /** Force every lit segment to one zone colour instead of the position-based ladder. */
  tone?: ProgressTone;
  children?: React.ReactNode;
}

function Progress({
  className,
  children,
  value,
  max = 100,
  variant = "bar",
  segments = 20,
  tone,
  ...props
}: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      value={value}
      max={max}
      data-slot="progress"
      data-variant={variant}
      className={cn("flex w-full min-w-0 flex-wrap gap-3", className)}
      {...props}
    >
      {children}
      {variant === "meter" ? (
        <ProgressSegments
          max={max}
          segments={segments}
          tone={tone}
          value={value}
        />
      ) : (
        <ProgressTrack>
          <ProgressIndicator />
        </ProgressTrack>
      )}
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "bg-muted relative flex h-2 w-full items-center overflow-x-hidden rounded-2xl shadow-[inset_0_1px_2px_var(--surface-shade)]",
        className
      )}
      data-slot="progress-track"
      {...props}
    />
  );
}

function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn(
        "surface-raised bg-primary h-full rounded-full transition-[width] duration-150 motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  );
}

export interface ProgressSegmentsProps extends ComponentProps<"div"> {
  value?: number | null;
  max?: number;
  segments?: number;
  tone?: ProgressTone;
}

/** The audiocn LED ladder: N segments that light up zone by zone, like a
 * level meter. Reads `value`/`max` directly instead of the indicator
 * context, since it paints discrete blocks rather than a continuous fill. */
function ProgressSegments({
  className,
  value,
  max = 100,
  segments = 20,
  tone,
  ...props
}: ProgressSegmentsProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, (value ?? 0) / max)) : 0;
  const lit = Math.round(ratio * segments);

  return (
    <div
      className={cn(
        "surface-inset border-border/60 flex w-full gap-0.5 rounded-md border p-1",
        className
      )}
      data-slot="progress-segments"
      {...props}
    >
      {Array.from({ length: segments }, (_, index) => {
        const isLit = index < lit;
        const percent = ((index + 1) / segments) * 100;
        const zone = tone ?? zoneForPercent(percent);
        return (
          <span
            className={cn(
              "h-2 flex-1 rounded-[2px] transition-colors",
              isLit ? TONE_CLASS[zone] : "bg-muted"
            )}
            data-lit={isLit ? "" : undefined}
            data-slot="progress-segment"
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
            key={index}
          />
        );
      })}
    </div>
  );
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn("text-sm font-medium", className)}
      data-slot="progress-label"
      {...props}
    />
  );
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn(
        "text-muted-foreground ml-auto font-mono text-xs tabular-nums",
        className
      )}
      data-slot="progress-value"
      {...props}
    />
  );
}

export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressSegments,
  ProgressLabel,
  ProgressValue,
};
