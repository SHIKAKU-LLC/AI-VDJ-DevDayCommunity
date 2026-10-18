import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";

const textareaVariants = cva(
  "surface-control placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 border-input flex field-sizing-content w-full resize-none rounded-2xl border text-base transition-[color,box-shadow] duration-200 outline-none read-only:cursor-default focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 md:text-sm",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default: "min-h-16 px-2.5 py-2",
        lg: "min-h-20 px-3 py-2.5",
        sm: "min-h-14 px-2 py-1.5 text-sm",
      },
    },
  }
);

export interface TextareaProps
  extends
    React.ComponentProps<"textarea">,
    VariantProps<typeof textareaVariants> {}

function Textarea({ className, size = "default", ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      data-size={size}
      className={cn(textareaVariants({ size }), className)}
      {...props}
    />
  );
}

export { Textarea, textareaVariants };
