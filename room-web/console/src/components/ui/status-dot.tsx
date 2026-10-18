import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";

export type StatusDotState =
  | "queued"
  | "building"
  | "ready"
  | "error"
  | "canceled"
  | "deleted";

const STATE_LABELS: Record<StatusDotState, string> = {
  building: "ビルド中",
  canceled: "キャンセル",
  deleted: "削除済み",
  error: "エラー",
  queued: "待機中",
  ready: "完了",
};

// The light is an LED: a solid core with a soft glow in its own colour, like
// the clip light and meter zones. In-flight states pulse; terminal ones hold.
const statusDotLightVariants = cva(
  "relative inline-block shrink-0 rounded-full transition-colors duration-150",
  {
    defaultVariants: {
      size: "default",
      state: "ready",
    },
    variants: {
      size: {
        default: "size-2.5",
        lg: "size-3",
        sm: "size-2",
      },
      state: {
        building:
          "bg-meter-warn shadow-[0_0_6px_var(--meter-warn)] motion-safe:animate-pulse",
        canceled: "bg-gray-700",
        deleted: "bg-gray-500",
        error: "bg-meter-clip shadow-[0_0_6px_var(--meter-clip)]",
        queued: "bg-gray-700 motion-safe:animate-pulse",
        ready: "bg-meter-ok shadow-[0_0_6px_var(--meter-ok)]",
      },
    },
  }
);

export interface StatusDotProps
  extends
    useRender.ComponentProps<"span">,
    VariantProps<typeof statusDotLightVariants> {
  state?: StatusDotState;
  /** Show the state name next to the light. Pass a string to override it. */
  label?: boolean | string;
  /** The thing whose state this is, read out before the state. */
  titlePrefix?: string;
}

const StatusDot = ({
  className,
  state = "ready",
  size,
  label = false,
  titlePrefix = "ステータス",
  render,
  ...props
}: StatusDotProps) => {
  const stateLabel = STATE_LABELS[state];
  const text = typeof label === "string" ? label : stateLabel;

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        "aria-label": `${titlePrefix}: ${text}`,
        children: (
          <>
            <span
              aria-hidden
              className={statusDotLightVariants({ size, state })}
              data-slot="status-dot-light"
            />
            {label ? (
              <span className="text-foreground" data-slot="status-dot-label">
                {text}
              </span>
            ) : null}
          </>
        ),
        className: cn(
          "inline-flex items-center gap-2 text-sm leading-none",
          className
        ),
        role: "status",
        title: `${titlePrefix}: ${text}`,
      },
      props
    ),
    render,
    state: {
      slot: "status-dot",
      state,
    },
  });
};

export { StatusDot, statusDotLightVariants };
