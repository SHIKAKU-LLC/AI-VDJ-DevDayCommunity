"use client";

import { SpinnerIcon } from "@phosphor-icons/react";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";

const spinnerVariants = cva("animate-spin", {
  defaultVariants: {
    size: "default",
  },
  variants: {
    size: {
      default: "size-4",
      lg: "size-5",
      sm: "size-3.5",
      xl: "size-6",
      xs: "size-3",
    },
  },
});

function Spinner({
  className,
  size,
  ...props
}: React.ComponentProps<"svg"> & VariantProps<typeof spinnerVariants>) {
  return (
    <SpinnerIcon
      data-slot="spinner"
      role="status"
      aria-label="読み込み中"
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    />
  );
}

export { Spinner, spinnerVariants };
