import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared empty / loading / error blocks (FO-UX02-C). Geometry and colour come
 * from the design tokens; semantics are fixed here so every surface announces
 * them the same way: loading is a polite status, an error is an alert.
 */

export function EmptyState({ title, description, action, className, testId }: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-1.5 px-4 py-8 text-center", className)} data-testid={testId}>
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description && <p className="max-w-prose text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function LoadingState({ label, className, testId }: { label: ReactNode; className?: string; testId?: string }) {
  return (
    <div role="status" className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)} data-testid={testId}>
      <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorState({ message, action, className, testId }: {
  message: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div role="alert" className={cn("flex flex-wrap items-center gap-2 text-sm text-destructive", className)} data-testid={testId}>
      <span className="min-w-0 break-words">{message}</span>
      {action}
    </div>
  );
}
