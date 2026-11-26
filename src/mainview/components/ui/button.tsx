import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Heights come from the density tokens (--control-h: 32/36/40px, see index.css);
// `disabled` drops pointer events outright; an `aria-disabled` button keeps
// them (its own click guard and `cursor-not-allowed` need them), so each
// variant pins its hover background back to its resting one instead. (The
// accent text colour is left alone: it matches the foreground, and pinning
// it would fight a caller's own text colour.)
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 max-w-full min-w-0 whitespace-normal break-words rounded-md text-sm font-medium ring-offset-background transition-[background-color,border-color,color,box-shadow,opacity] duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
  {
    // FO-UX-VISUAL01: the primary action is the ForgeOrbit purple fill
    // (--brand-solid); everything else stays neutral so one page carries at
    // most one accent-filled button.
    variants: {
      variant: {
        default: "bg-brand-solid text-brand-solid-foreground shadow-sm hover:bg-brand-solid/90 active:bg-brand-solid/85 aria-disabled:hover:bg-brand-solid",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 aria-disabled:hover:bg-destructive",
        outline:
          "border border-input bg-card shadow-sm hover:bg-accent hover:text-accent-foreground aria-disabled:hover:bg-card",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent aria-disabled:hover:bg-secondary",
        ghost: "hover:bg-accent hover:text-accent-foreground aria-disabled:hover:bg-transparent",
        link: "text-primary underline-offset-4 hover:underline aria-disabled:hover:no-underline",
      },
      size: {
        default: "min-h-control h-auto px-4 py-2",
        sm: "min-h-control-sm h-auto rounded-md px-3 py-1 text-xs",
        lg: "min-h-control-lg h-auto rounded-md px-8",
        icon: "h-control w-control shrink-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {  return (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ); },
);
Button.displayName = "Button";

export { buttonVariants };
