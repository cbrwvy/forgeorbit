import { staticLabel } from "@/i18n/presentation";
import { useLocale as useUILocale } from "@/i18n/react";
import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => { useUILocale(); return (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-control w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-[border-color,box-shadow] duration-fast ease-standard hover:border-muted-foreground/40 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
      placeholder={props.placeholder ? staticLabel(props.placeholder) : props.placeholder}
      aria-label={props["aria-label"] ? staticLabel(props["aria-label"]) : props["aria-label"]}
      title={props.title ? staticLabel(props.title) : props.title}
    />
  ); },
);
Input.displayName = "Input";
