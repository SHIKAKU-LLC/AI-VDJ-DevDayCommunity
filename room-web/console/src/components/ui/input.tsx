import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";

const inputVariants = cva(
  "surface-control file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 border-input w-full min-w-0 rounded-2xl border text-base transition-[color,box-shadow] duration-200 outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 md:text-sm",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default: "h-8 px-2.5 py-1",
        lg: "h-9 px-3 py-1.5",
        sm: "h-7 px-2 py-1 text-sm",
      },
    },
  }
);

export interface InputProps
  extends
    Omit<React.ComponentProps<typeof InputPrimitive>, "size">,
    VariantProps<typeof inputVariants> {}

function Input({ className, type, size = "default", ...props }: InputProps) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(inputVariants({ size }), className)}
      {...props}
    />
  );
}

export { Input, inputVariants };
