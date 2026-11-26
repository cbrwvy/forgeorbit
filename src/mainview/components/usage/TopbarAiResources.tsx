import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitBranch, Layers, MoreHorizontal, Workflow } from "lucide-react";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { useAnchoredPosition } from "@/components/ui/floating";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { AgentStatus, Harness, HarnessQuota } from "../../../shared/types.ts";
import type { ExecutionProfile } from "../../../shared/accounts/execution-profile.ts";
import type { HarnessInstallation } from "../../../shared/harness-installation.ts";
import {
  buildAllTopbarServices,
  type TopbarServiceId,
  type TopbarServiceSummary,
} from "./service-status";
import {
  SERVICE_LIGHT_DOT,
  TopbarServiceCard,
  serviceTooltipText,
} from "./TopbarServicePopover";

export interface TopbarAiResourcesProps {
  agents: AgentStatus[];
  harnesses: Harness[];
  usage: Record<string, HarnessQuota>;
  installations?: HarnessInstallation[];
  onOpenAccounts: (harnessId?: string) => void;
  /** Optional preloaded profiles for deterministic unit tests; when omitted, reads `api.accountCore.executionProfiles()` passively. */
  initialProfiles?: ExecutionProfile[];
}

const POPOVER_WIDTH = 328;

interface TopbarServicePopoverLayerProps {
  service: TopbarServiceSummary;
  anchorEl: HTMLButtonElement | null;
  layerRef: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onOpenAccounts: (harnessId?: string) => void;
}

function TopbarServicePopoverLayer({
  service,
  anchorEl,
  layerRef,
  onKeyDown,
  onOpenAccounts,
}: TopbarServicePopoverLayerProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(anchorEl);
  anchorRef.current = anchorEl;
  const position = useAnchoredPosition(anchorRef, layerRef, true, POPOVER_WIDTH);

  useEffect(() => {
    layerRef.current?.focus();
  }, [layerRef]);

  return createPortal(
    <div
      ref={layerRef}
      role="dialog"
      aria-label={service.label}
      data-testid="topbar-service-panel"
      data-service-id={service.id}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={position}
      className="electrobun-webkit-app-region-no-drag glass-floating z-popover max-h-[75vh] w-[328px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-border p-3.5 text-xs text-card-foreground shadow-xl outline-none"
    >
      <TopbarServiceCard service={service} onOpenAccounts={onOpenAccounts} />
    </div>,
    document.body,
  );
}

/**
 * Compact 4-service status strip in the top application bar:
 * Codex, Claude, Cursor, Antigravity — each with a single traffic-light
 * indicator dot and a focused per-service read-only popover on click.
 */
export function TopbarAiResources({
  agents,
  harnesses,
  usage,
  installations,
  onOpenAccounts,
  initialProfiles,
}: TopbarAiResourcesProps) {
  useUILocale();
  const [openServiceId, setOpenServiceId] = useState<TopbarServiceId | null>(null);
  const [profiles, setProfiles] = useState<ExecutionProfile[]>(initialProfiles ?? []);
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Partial<Record<TopbarServiceId, HTMLButtonElement | null>>>({});

  // Passive read of execution profiles on mount / harness updates (never runs any CLI or quota probe).
  useEffect(() => {
    if (initialProfiles !== undefined) {
      setProfiles(initialProfiles);
      return;
    }
    let cancelled = false;
    api.accountCore
      .executionProfiles()
      .then((res) => {
        if (!cancelled) setProfiles(res.profiles);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialProfiles, agents, harnesses]);

  // Passive snapshot sync when opening a popover (still strictly DB/memory read, zero CLI calls).
  useEffect(() => {
    if (!openServiceId || initialProfiles !== undefined) return;
    let cancelled = false;
    api.accountCore
      .executionProfiles()
      .then((res) => {
        if (!cancelled) setProfiles(res.profiles);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [openServiceId, initialProfiles]);

  const services = useMemo<TopbarServiceSummary[]>(
    () =>
      buildAllTopbarServices({ agents, harnesses, usage, profiles, installations }).filter(
        (s) => s.connected,
      ),
    [agents, harnesses, usage, profiles, installations],
  );

  const activeService = useMemo(
    () => (openServiceId ? services.find((s) => s.id === openServiceId) ?? null : null),
    [openServiceId, services],
  );

  useEffect(() => {
    if (openServiceId && !services.some((s) => s.id === openServiceId)) {
      setOpenServiceId(null);
    }
  }, [openServiceId, services]);

  useEffect(() => {
    if (!openServiceId) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !layerRef.current?.contains(target)) {
        setOpenServiceId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const trigger = triggerRefs.current[openServiceId] ?? null;
        setOpenServiceId(null);
        if (
          layerRef.current?.contains(document.activeElement) ||
          document.activeElement === document.body ||
          document.activeElement === trigger
        ) {
          trigger?.focus();
        }
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openServiceId]);

  const onLayerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const items = Array.from(
      layerRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), summary") ?? [],
    );
    const active = document.activeElement;
    const leavingForward = !e.shiftKey && (items.length === 0 || active === items[items.length - 1]);
    const leavingBackward = e.shiftKey && (active === layerRef.current || active === items[0]);
    if (leavingForward || leavingBackward) {
      e.preventDefault();
      const trigger = openServiceId ? triggerRefs.current[openServiceId] : null;
      setOpenServiceId(null);
      trigger?.focus();
    }
  };

  const onGroupKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const nextIndex =
      e.key === "ArrowRight"
        ? (index + 1) % services.length
        : (index - 1 + services.length) % services.length;
    const nextService = services[nextIndex];
    if (nextService) {
      triggerRefs.current[nextService.id]?.focus();
      if (openServiceId !== null) setOpenServiceId(nextService.id);
    }
  };

  if (services.length === 0) return null;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={tr("topbar.services.group_label")}
      data-testid="topbar-ai-resources"
      className="electrobun-webkit-app-region-no-drag relative inline-flex h-8 shrink-0 items-center gap-1"
    >
      {services.map((service, index) => {
        const isOpen = openServiceId === service.id;
        const tooltip = serviceTooltipText(service);
        return (
          <button
            key={service.id}
            ref={(el) => {
              triggerRefs.current[service.id] = el;
            }}
            type="button"
            data-testid={`topbar-service-${service.id}`}
            data-service-id={service.id}
            data-service-status={service.light}
            title={tooltip}
            aria-label={tooltip}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpenServiceId((cur) => (cur === service.id ? null : service.id));
            }}
            onKeyDown={(e) => onGroupKeyDown(e, index)}
            className={cn(
              "relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isOpen ? "bg-accent/80 text-accent-foreground" : "hover:bg-accent/50",
            )}
          >
            <AgentIcon
              kind={service.agentKind}
              className={cn(
                "size-4 transition-opacity",
                service.light === "red" && "opacity-45",
              )}
            />
            <span
              data-testid={`topbar-service-dot-${service.id}`}
              data-service-light={service.light}
              aria-hidden
              className={cn(
                "absolute bottom-0.5 right-0.5 size-2 rounded-full",
                SERVICE_LIGHT_DOT[service.light],
              )}
            />
          </button>
        );
      })}

      {activeService && (
        <TopbarServicePopoverLayer
          key={activeService.id}
          service={activeService}
          anchorEl={triggerRefs.current[activeService.id] ?? null}
          layerRef={layerRef}
          onKeyDown={onLayerKeyDown}
          onOpenAccounts={(harnessId) => {
            setOpenServiceId(null);
            onOpenAccounts(harnessId);
          }}
        />
      )}
    </div>
  );
}

export interface TopbarOverflowMenuProps {
  hasProjects: boolean;
  pipelinesActive: boolean;
  onOpenGit: () => void;
  onOpenWorktrees: () => void;
  onTogglePipelines: () => void;
}

export function TopbarOverflowMenu({
  hasProjects,
  pipelinesActive,
  onOpenGit,
  onOpenWorktrees,
  onTogglePipelines,
}: TopbarOverflowMenuProps) {
  useUILocale();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const position = useAnchoredPosition(rootRef, layerRef, open, 220);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !layerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        if (
          layerRef.current?.contains(document.activeElement) ||
          document.activeElement === document.body ||
          document.activeElement === triggerRef.current
        ) {
          triggerRef.current?.focus();
        }
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      const firstItem = layerRef.current?.querySelector<HTMLElement>("button:not(:disabled)");
      (firstItem ?? layerRef.current)?.focus();
    }
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      layerRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [],
    );
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) items[(idx + 1) % items.length]?.focus();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) items[(idx - 1 + items.length) % items.length]?.focus();
      return;
    }
    if (e.key === "Tab") {
      const leavingForward = !e.shiftKey && (items.length === 0 || active === items[items.length - 1]);
      const leavingBackward = e.shiftKey && (active === layerRef.current || active === items[0]);
      if (leavingForward || leavingBackward) {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
  };

  return (
    <div ref={rootRef} className="electrobun-webkit-app-region-no-drag relative inline-flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid="topbar-more-actions"
        title={tr("topbar.more_actions")}
        aria-label={tr("topbar.more_actions")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open &&
        createPortal(
          <div
            ref={layerRef}
            role="menu"
            aria-label={tr("topbar.more_actions")}
            data-testid="topbar-more-menu"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            tabIndex={-1}
            onKeyDown={onMenuKeyDown}
            style={position}
            className="electrobun-webkit-app-region-no-drag glass-floating z-popover w-[220px] rounded-xl border border-border p-1.5 text-xs text-card-foreground shadow-xl outline-none"
          >
            <button
              type="button"
              role="menuitem"
              data-testid="pipelines-button"
              aria-pressed={pipelinesActive}
              title={tr("common.pipelines")}
              onClick={() => {
                setOpen(false);
                onTogglePipelines();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Workflow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>{tr("common.pipelines")}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              data-testid="worktrees-button"
              title={tr("common.worktrees")}
              onClick={() => {
                setOpen(false);
                onOpenWorktrees();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>{tr("common.worktrees")}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              data-testid="git-button"
              aria-label="Git"
              disabled={!hasProjects}
              title={tr("navigation.git_pull_requests_and_issues_github_gitlab_bitbucket")}
              onClick={() => {
                setOpen(false);
                onOpenGit();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>Git</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
