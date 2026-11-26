import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium leading-4 transition-colors",
  {
    // FO-UX-VISUAL01: quiet labels. Status variants are tinted (token at
    // 12-15% with token-coloured text), never a saturated fill, and callers
    // still pair them with text or an icon — colour alone carries nothing.
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        destructive: "border-transparent bg-danger/10 text-danger",
        success: "border-transparent bg-success/10 text-success",
        warning: "border-transparent bg-warning/15 text-warning",
        info: "border-transparent bg-info/10 text-info",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {

  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
