"use client";

import {
  ArrowUpIcon,
  SpinnerGapIcon,
  StopIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { cn } from "cn";
import type * as React from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";

export type PromptInputStatus = "idle" | "submitted" | "streaming" | "error";

const PromptInput = ({
  className,
  children,
  ...props
}: React.ComponentProps<"form">) => (
  <form
    data-slot="prompt-input"
    className={cn("w-full min-w-0", className)}
    {...props}
  >
    <InputGroup className="border-border bg-card! rounded-2xl p-1 shadow-[inset_0_1px_0_var(--surface-glint),0_4px_16px_-10px_var(--surface-shade)]!">
      {children}
    </InputGroup>
  </form>
);

const PromptInputTextarea = ({
  className,
  onKeyDown,
  rows = 1,
  ...props
}: React.ComponentProps<typeof InputGroupTextarea>) => (
  <InputGroupTextarea
    data-slot="prompt-input-textarea"
    rows={rows}
    className={cn(
      "max-h-60 min-h-20 resize-none px-3 pt-3 pb-2 text-base leading-relaxed sm:text-sm",
      className
    )}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (
        !event.defaultPrevented &&
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing &&
        event.nativeEvent.keyCode !== 229
      ) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    }}
    {...props}
  />
);

const PromptInputAttachments = ({
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroupAddon>, "align">) => (
  <InputGroupAddon
    data-slot="prompt-input-attachments"
    align="block-start"
    className={cn("flex-wrap gap-2", className)}
    {...props}
  />
);

const PromptInputToolbar = ({
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroupAddon>, "align">) => (
  <InputGroupAddon
    data-slot="prompt-input-toolbar"
    align="block-end"
    className={cn("w-full justify-between gap-2 px-2 pb-2", className)}
    {...props}
  />
);

const PromptInputActions = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    data-slot="prompt-input-actions"
    className={cn("flex items-center gap-1", className)}
    {...props}
  />
);

const PROMPT_INPUT_SUBMIT_LABELS: Record<PromptInputStatus, string> = {
  error: "再試行",
  idle: "送信",
  streaming: "停止",
  submitted: "送信中",
};

const PromptInputSubmit = ({
  className,
  status = "idle",
  disabled,
  type,
  children,
  ...props
}: React.ComponentProps<typeof InputGroupButton> & {
  status?: PromptInputStatus;
}) => {
  const resolvedType = type ?? (status === "streaming" ? "button" : "submit");

  return (
    <InputGroupButton
      type={resolvedType}
      size="icon-sm"
      variant="default"
      aria-label={PROMPT_INPUT_SUBMIT_LABELS[status]}
      disabled={disabled ?? status === "submitted"}
      data-slot="prompt-input-submit"
      data-status={status}
      className={cn("ml-auto size-8 rounded-xl", className)}
      {...props}
    >
      {children ?? (
        <>
          {status === "idle" && <ArrowUpIcon />}
          {status === "submitted" && (
            <SpinnerGapIcon className="motion-safe:animate-spin" />
          )}
          {status === "streaming" && <StopIcon weight="fill" />}
          {status === "error" && <WarningIcon />}
        </>
      )}
    </InputGroupButton>
  );
};

export {
  PromptInput,
  PromptInputTextarea,
  PromptInputAttachments,
  PromptInputToolbar,
  PromptInputActions,
  PromptInputSubmit,
};
