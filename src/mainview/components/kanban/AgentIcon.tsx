import { useLocale as useUILocale } from "@/i18n/react";
import { Antigravity, ClaudeCode, Codex, Cursor, DeepSeek, GeminiCLI, GithubCopilot, OpenCode, Vercel } from "@lobehub/icons";
import { Terminal } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";
import type { AgentKind } from "../../../shared/types.ts";

type IconProps = { size?: number | string; className?: string; "aria-hidden"?: boolean };

const ICONS: Record<AgentKind | "deepseek" | "deepseek-dsh" | "opencode" | "copilot", ComponentType<IconProps>> = {
  "claude-code": ClaudeCode.Color,
  "codex": Codex.Color,
  // @lobehub/icons ships no `.Color` variant for Cursor (its mark is
  // monochrome by design) — the plain (Mono) export is the closest
  // equivalent to Claude/Codex's colored glyphs here.
  "cursor": Cursor,
  "deepseek": DeepSeek.Color,
  "deepseek-dsh": DeepSeek.Color,
  "gemini": GeminiCLI.Color,
  "antigravity": Antigravity.Color,
  // Same story as Cursor above — @lobehub/icons ships no `.Color` variant
  // for Vercel (fx's maker), so the plain (Mono) triangle glyph is the
  // closest equivalent.
  "fx": Vercel,
  "opencode": OpenCode,
  "copilot": GithubCopilot,
  "custom": Terminal,
};

/**
 * Renders the brand glyph for a CLI kind or known service id. Accepts any string
 * so callers can pass an unresolved harness/service id directly — unknown custom
 * CLIs render a clean Terminal icon.
 */
export function AgentIcon({ kind, className }: { kind: AgentKind | string; className?: string }) {
  useUILocale();
  const Icon = ICONS[kind as keyof typeof ICONS] ?? ICONS["custom"];
  return <Icon size="1em" className={cn("size-3.5", className)} aria-hidden />;
}
