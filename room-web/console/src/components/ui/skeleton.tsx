import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";

const skeletonVariants = cva("bg-muted", {
  defaultVariants: {
    shape: "default",
  },
  variants: {
    shape: {
      default: "rounded-2xl",
      pill: "rounded-full",
      rounded: "rounded-xl",
      squared: "rounded-md",
    },
  },
});

interface SkeletonProps
  extends React.ComponentProps<"div">, VariantProps<typeof skeletonVariants> {
  /** Animate with a pulse. Default true. */
  animated?: boolean;
}

function Skeleton({
  className,
  shape = "default",
  animated = true,
  children,
  ...props
}: SkeletonProps) {
  if (children) {
    return (
      <span
        className={cn("relative inline-flex", className)}
        data-shape={shape}
        data-slot="skeleton"
        {...props}
      >
        <span className="invisible" data-slot="skeleton-content">
          {children}
        </span>
        <span
          aria-hidden
          className={cn(
            skeletonVariants({ shape }),
            animated && "animate-pulse",
            "absolute inset-0"
          )}
          data-slot="skeleton-overlay"
        />
      </span>
    );
  }

  return (
    <div
      data-shape={shape}
      data-slot="skeleton"
      className={cn(
        skeletonVariants({ shape }),
        animated && "animate-pulse",
        className
      )}
      {...props}
    />
  );
}

export { Skeleton, skeletonVariants };
