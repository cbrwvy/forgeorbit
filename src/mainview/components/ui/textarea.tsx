import { staticLabel } from "@/i18n/presentation";
import { useLocale as useUILocale } from "@/i18n/react";
import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => { useUILocale(); return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-[border-color,box-shadow] duration-fast ease-standard placeholder:text-muted-foreground hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
      placeholder={props.placeholder ? staticLabel(props.placeholder) : props.placeholder}
      aria-label={props["aria-label"] ? staticLabel(props["aria-label"]) : props["aria-label"]}
      title={props.title ? staticLabel(props.title) : props.title}
    />
  ); },
);
Textarea.displayName = "Textarea";
