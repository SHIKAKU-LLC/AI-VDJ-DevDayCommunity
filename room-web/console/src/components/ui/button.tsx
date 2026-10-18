import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";

import { Spinner } from "@/components/ui/spinner";

const buttonVariants = cva(
  "group/button focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 inline-flex shrink-0 items-center justify-center rounded-2xl border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 outline-none select-none focus-visible:ring-3 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-3 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      shape: "default",
      size: "default",
      variant: "default",
    },
    variants: {
      shape: {
        circle: "rounded-full",
        default: "",
        rounded: "rounded-full",
        square: "rounded-lg",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        icon: "size-8",
        "icon-lg": "size-9",
        "icon-sm": "size-7",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        sm: "h-7 gap-1 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
      },
      variant: {
        default:
          "surface-raised bg-primary text-primary-foreground hover:bg-primary/80",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        outline:
          "surface-raised border-border bg-muted/40 hover:border-foreground/20 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "surface-raised bg-secondary text-secondary-foreground aria-expanded:bg-secondary aria-expanded:text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        warning:
          "bg-meter-warn/10 text-meter-warn-foreground hover:bg-meter-warn/20 focus-visible:border-meter-warn/40 focus-visible:ring-meter-warn/20 dark:bg-meter-warn/20 dark:hover:bg-meter-warn/30 dark:focus-visible:ring-meter-warn/40",
      },
    },
  }
);

export interface ButtonProps
  extends ButtonPrimitive.Props, VariantProps<typeof buttonVariants> {
  /** Shows a spinner in place of the start icon and disables the button while true. */
  loading?: boolean;
}

const Button = ({
  className,
  variant = "default",
  size = "default",
  shape = "default",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) => (
  <ButtonPrimitive
    aria-busy={loading || undefined}
    data-loading={loading ? "" : undefined}
    data-slot="button"
    disabled={disabled || loading}
    className={cn(buttonVariants({ className, shape, size, variant }))}
    {...props}
  >
    {loading ? <Spinner aria-hidden data-icon="inline-start" /> : null}
    {children}
  </ButtonPrimitive>
);

export { Button, buttonVariants };
