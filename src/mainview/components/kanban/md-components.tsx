import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useState } from "react";
import type React from "react";
import ReactMarkdown from "react-markdown";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { MdImage } from "./MdImage";

/**
 * Shared `ReactMarkdown` renderer pieces (external-link handling, code-block
 * chrome, the user/assistant `components` maps) hoisted into their own leaf
 * module so both `RunPanel.tsx` and `PlanDialog.tsx` can import them without
 * creating a circular dependency between the two — `PlanDialog` used to pull
 * `ASSISTANT_MD_COMPONENTS` back out of `RunPanel`, which imports `PlanDialog`
 * itself. See docs/plans/cursor-plan-approval.md code-review findings.
 *
 * Also the one leaf module every markdown-image consumer imports from:
 * `MdImage` (the shared `img` override, added to both maps below and
 * re-exported from `./MdImage`), `MdImageScopeContext`/
 * `EMPTY_MD_IMAGE_SCOPE`/`MdImageScope` (also re-exported from `./MdImage`)
 * and `MD_URL_TRANSFORM` (re-exported from `@/lib/md-image`, aliased so a
 * call site only needs one import line for the `components`/`urlTransform`
 * pair). See docs/plans/markdown-image-rendering.md D2/D3.
 */

export type MdComponents = NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]>;

/** Keep wide result tables inside the transcript and reachable by keyboard. */
export function MarkdownTable({ children }: { children?: React.ReactNode }) {
  useUILocale();
  return (
    <div role="region" aria-label={tr("common.scrollable_table")} tabIndex={0} className="max-w-full overflow-x-auto rounded-sm">
      <table>{children}</table>
    </div>
  );
}

/**
 * Anchor that hands off http(s)/mailto navigation to the OS default browser
 * via Electrobun's `Utils.openExternal`. The webview is sandboxed —
 * `target="_blank"` is a no-op there — so every link in agent output has to
 * round-trip through the main process to reach a real browser.
 */
export function ExternalLink({
  href,
  className,
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  useUILocale();
  const safe = typeof href === "string" && /^(https?|mailto):/i.test(href) ? href : null;
  return (
    <a
      {...rest}
      href={safe ?? "#"}
      onClick={(e) => {
        e.preventDefault();
        if (!safe) return;
        void api.openExternal(safe).catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : "Could not open link");
        });
      }}
      className={cn("text-primary underline-offset-2 hover:underline", className)}
    >
      {children}
    </a>
  );
}

// External links open in the system browser via the OS handler.
const mdRenderLink: NonNullable<MdComponents["a"]> = ({ href, children, ...rest }) => (
  <ExternalLink {...rest} href={href}>
    {children}
  </ExternalLink>
);

const mdRenderCode: NonNullable<MdComponents["code"]> = ({ className, children, ...props }) => {
  const isBlock = /language-/.test(className ?? "");
  if (isBlock) {
    return (
      <code className={cn(className, "font-mono text-[11px]")} {...props}>
        {children}
      </code>
    );
  }
  return (
    <code
      className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px] text-foreground"
      {...props}
    >
      {children}
    </code>
  );
};

function nodeToText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    return nodeToText((node as { props: { children: unknown } }).props.children);
  }
  return "";
}

export function CodeBlock({
  children,
  bgClassName,
}: {
  children: React.ReactNode;
  bgClassName: string;
}) {
  useUILocale();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const text = nodeToText(children).replace(/\n$/, "");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(tr("common.couldn_t_copy_to_clipboard"));
    }
  };
  return (
    <div className="group relative my-2">
      <pre
        className={cn(
          "overflow-auto rounded-md border border-border/40 p-2 pr-9 font-mono text-[11px] leading-relaxed",
          bgClassName,
        )}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? tr("common.copied") : tr("common.copy_code")}
        title={copied ? tr("common.copied") : tr("common.copy")}
        className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded border border-border/60 bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

export const USER_MD_COMPONENTS: MdComponents = {
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
  a: mdRenderLink,
  code: mdRenderCode,
  img: MdImage,
  pre: ({ children }) => <CodeBlock bgClassName="bg-background/60">{children}</CodeBlock>,
};

// Used by `AssistantBlock` in RunPanel and by `PlanDialog` (a plan's markdown
// gets the exact same link/code-block treatment as an assistant message
// instead of duplicating the `mdRenderLink`/`mdRenderCode`/`CodeBlock` wiring).
export const ASSISTANT_MD_COMPONENTS: MdComponents = {
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
  a: mdRenderLink,
  code: mdRenderCode,
  img: MdImage,
  pre: ({ children }) => <CodeBlock bgClassName="bg-muted/40">{children}</CodeBlock>,
};

// Re-exported so every markdown-image consumer (RunPanel, PlanDialog,
// MessageSegments, GitHubDialog — T4) imports both the `components` map and
// its scope/transform partners from this one leaf module instead of reaching
// into `./MdImage` / `@/lib/md-image` directly.
export { MdImage, MdImageScopeContext, EMPTY_MD_IMAGE_SCOPE, type MdImageScope } from "./MdImage";
export { mdUrlTransform as MD_URL_TRANSFORM } from "@/lib/md-image";
