"use client";

import {
  CheckCircleIcon,
  InfoIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";

export type NoteVariant =
  | "default"
  | "info"
  | "success"
  | "warning"
  | "error"
  | "secondary"
  | "violet"
  | "cyan";

const NOTE_ICONS: Record<NoteVariant, ReactNode> = {
  cyan: <InfoIcon />,
  default: <InfoIcon />,
  error: <XCircleIcon />,
  info: <InfoIcon />,
  secondary: <InfoIcon />,
  success: <CheckCircleIcon />,
  violet: <InfoIcon />,
  warning: <WarningIcon />,
};

const noteVariants = cva(
  "group/note relative flex w-full items-start gap-2.5 rounded-2xl border text-sm shadow-[inset_0_1px_0_var(--surface-glint)] data-disabled:pointer-events-none data-disabled:opacity-50 [&_[data-slot=note-icon]]:mt-0.5 [&_[data-slot=note-icon]]:shrink-0",
  {
    compoundVariants: [
      {
        class: "border-border bg-card text-foreground",
        fill: false,
        variant: "default",
      },
      {
        class:
          "bg-muted/40 text-foreground [&_[data-slot=note-icon]]:text-muted-foreground border-border/80",
        fill: true,
        variant: "default",
      },
      {
        class:
          "border-info/30 bg-card text-foreground [&_[data-slot=note-icon]]:text-info",
        fill: false,
        variant: "info",
      },
      {
        class:
          "bg-info/10 text-info-foreground [&_[data-slot=note-icon]]:text-info border-transparent",
        fill: true,
        variant: "info",
      },
      {
        class:
          "border-success/30 bg-card text-foreground [&_[data-slot=note-icon]]:text-success",
        fill: false,
        variant: "success",
      },
      {
        class:
          "bg-success/10 text-success-foreground [&_[data-slot=note-icon]]:text-success border-transparent",
        fill: true,
        variant: "success",
      },
      {
        class:
          "border-warning/30 bg-card text-foreground [&_[data-slot=note-icon]]:text-warning",
        fill: false,
        variant: "warning",
      },
      {
        class:
          "bg-warning/10 text-warning-foreground [&_[data-slot=note-icon]]:text-warning border-transparent",
        fill: true,
        variant: "warning",
      },
      {
        class:
          "border-destructive/30 bg-card text-foreground [&_[data-slot=note-icon]]:text-destructive",
        fill: false,
        variant: "error",
      },
      {
        class:
          "bg-destructive/10 text-destructive [&_[data-slot=note-icon]]:text-destructive border-transparent",
        fill: true,
        variant: "error",
      },
      {
        class:
          "border-border bg-muted/50 text-foreground [&_[data-slot=note-icon]]:text-muted-foreground",
        fill: false,
        variant: "secondary",
      },
      {
        class:
          "bg-muted/40 text-foreground [&_[data-slot=note-icon]]:text-muted-foreground border-border/80",
        fill: true,
        variant: "secondary",
      },
      {
        class:
          "border-violet/30 bg-card text-foreground [&_[data-slot=note-icon]]:text-violet",
        fill: false,
        variant: "violet",
      },
      {
        class:
          "bg-violet/10 text-violet-foreground [&_[data-slot=note-icon]]:text-violet border-transparent",
        fill: true,
        variant: "violet",
      },
      {
        class:
          "border-cyan/30 bg-card text-foreground [&_[data-slot=note-icon]]:text-cyan",
        fill: false,
        variant: "cyan",
      },
      {
        class:
          "bg-cyan/10 text-cyan-foreground [&_[data-slot=note-icon]]:text-cyan border-transparent",
        fill: true,
        variant: "cyan",
      },
    ],
    defaultVariants: {
      fill: false,
      size: "default",
      variant: "default",
    },
    variants: {
      fill: {
        false: "",
        true: "",
      },
      size: {
        default:
          "px-3.5 py-3 [&_[data-slot=note-action]]:self-center [&_[data-slot=note-icon]]:size-4",
        sm: "px-3 py-2.5 text-xs [&_[data-slot=note-action]]:self-center [&_[data-slot=note-icon]]:size-3.5",
      },
      variant: {
        cyan: "",
        default: "",
        error: "",
        info: "",
        secondary: "",
        success: "",
        violet: "",
        warning: "",
      },
    },
  }
);

export interface NoteProps
  extends ComponentProps<"div">, VariantProps<typeof noteVariants> {
  /** Replaces the variant's default icon. Pass `null` to render no icon. */
  icon?: ReactNode;
  disabled?: boolean;
}

const Note = ({
  className,
  variant: variantProp = "default",
  size = "default",
  fill = false,
  icon,
  disabled = false,
  children,
  ...props
}: NoteProps) => {
  const variant = variantProp ?? "default";
  const resolvedIcon = icon === undefined ? NOTE_ICONS[variant] : icon;

  return (
    <div
      data-disabled={disabled ? "" : undefined}
      data-fill={fill ? "" : undefined}
      data-slot="note"
      data-variant={variant}
      className={cn(noteVariants({ fill, size, variant }), className)}
      {...props}
    >
      {resolvedIcon ? (
        <span aria-hidden data-slot="note-icon">
          {resolvedIcon}
        </span>
      ) : null}
      {children}
    </div>
  );
};

const NoteContent = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn(
      "[&_a]:hover:text-foreground min-w-0 flex-1 [&_a]:underline [&_a]:underline-offset-3",
      className
    )}
    data-slot="note-content"
    {...props}
  />
);

const NoteLabel = ({ className, ...props }: ComponentProps<"span">) => (
  <span
    className={cn("mr-1 font-medium", className)}
    data-slot="note-label"
    {...props}
  />
);

const NoteAction = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn("shrink-0", className)}
    data-slot="note-action"
    {...props}
  />
);

export { Note, NoteContent, NoteLabel, NoteAction, noteVariants };
