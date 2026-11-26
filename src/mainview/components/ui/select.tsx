import { staticLabel } from "@/i18n/presentation";
import { useLocale as useUILocale } from "@/i18n/react";
import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Minimal styled wrapper around a native <select>. We strip the browser's
 * native caret (`appearance-none`) so the dark theme renders consistently
 * across platforms, and paint a lucide chevron in its place so the field
 * still reads as a dropdown at rest.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => { useUILocale(); return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "flex h-control w-full appearance-none rounded-md border border-input bg-background pl-3 pr-8 py-1 text-sm shadow-sm transition-[border-color,box-shadow] duration-fast ease-standard hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
        aria-label={props["aria-label"] ? staticLabel(props["aria-label"]) : props["aria-label"]}
        title={props.title ? staticLabel(props.title) : props.title}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 opacity-60"
      />
    </div>
  ); },
);
Select.displayName = "Select";
