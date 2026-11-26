import { t as tr } from "@/i18n/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { BrainKind } from "../../../../shared/brain/document.ts";
import type { MemoryProposal, MemoryProposalPermission } from "../../../../shared/brain/proposals.ts";

const KINDS: BrainKind[] = ["fact", "decision", "observation"];

export interface MemoryProposalOptInValue {
  allow: boolean;
  company: boolean;
  projectPaths: string[];
}

export function memoryProposalSendFields(value: MemoryProposalOptInValue): Partial<MemoryProposalPermission> & { allowMemoryProposals?: boolean; allowCompanyMemoryProposals?: boolean; memoryProposalProjectPaths?: string[] } {
  if (!value.allow) return {};
  return {
    allowMemoryProposals: true,
    ...(value.company ? { allowCompanyMemoryProposals: true } : {}),
    ...(value.projectPaths.length > 0 ? { memoryProposalProjectPaths: value.projectPaths } : {}),
  };
}

export function MemoryProposalOptIn({
  mode,
  projects = [],
  value,
  onChange,
  disabled,
  testId,
}: {
  mode: "project" | "portfolio";
  projects?: readonly { path: string; name: string }[];
  value: MemoryProposalOptInValue;
  onChange: (value: MemoryProposalOptInValue) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <div className="space-y-1 text-[11px] text-muted-foreground" data-testid={testId}>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value.allow}
          disabled={disabled}
          data-testid={`${testId}-allow`}
          onChange={(event) => onChange({ allow: event.target.checked, company: false, projectPaths: [] })}
        />
        {tr("brain.proposal.allow")}
      </label>
      {value.allow && (
        <>
          <p data-testid={`${testId}-note`}>{tr("brain.proposal.allow_note")}</p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.company}
              disabled={disabled}
              data-testid={`${testId}-company`}
              onChange={(event) => onChange({ ...value, company: event.target.checked })}
            />
            {tr("brain.proposal.company")}
          </label>
          {mode === "portfolio" && projects.length > 0 && (
            <fieldset className="space-y-1" data-testid={`${testId}-projects`}>
              <legend>{tr("brain.proposal.projects")}</legend>
              {projects.slice(0, 8).map((project) => (
                <label key={project.path} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={value.projectPaths.includes(project.path)}
                    disabled={disabled || (!value.projectPaths.includes(project.path) && value.projectPaths.length >= 8)}
                    onChange={(event) => {
                      const projectPaths = event.target.checked
                        ? [...value.projectPaths, project.path]
                        : value.projectPaths.filter((path) => path !== project.path);
                      onChange({ ...value, projectPaths });
                    }}
                  />
                  <span className="truncate">{project.name}</span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}

export function MemoryProposalList({ messageId, onOpenBrain }: { messageId: string; onOpenBrain?: (scopeKind: "company" | "project") => void }) {
  const [items, setItems] = useState<MemoryProposal[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.listMemoryProposals({ messageId }).then(
      (page) => { if (!cancelled) setItems(page.proposals); },
      () => { if (!cancelled) setItems([]); },
    );
    return () => { cancelled = true; };
  }, [messageId]);
  if (!items || items.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="memory-proposal-list">
      {items.map((proposal) => (
        <MemoryProposalCard
          key={proposal.id}
          proposal={proposal}
          onChanged={(next) => setItems((current) => current?.map((item) => item.id === next.id ? next : item) ?? [next])}
          onOpenBrain={onOpenBrain}
        />
      ))}
    </div>
  );
}

export function MemoryProposalCard({
  proposal,
  onChanged,
  onOpenBrain,
}: {
  proposal: MemoryProposal;
  onChanged?: (proposal: MemoryProposal) => void;
  onOpenBrain?: (scopeKind: "company" | "project") => void;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [kind, setKind] = useState(proposal.kind);
  const [content, setContent] = useState(proposal.content);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = proposal.status === "pending";
  const dirty = title !== proposal.title || kind !== proposal.kind || content !== proposal.content;

  useEffect(() => {
    setTitle(proposal.title);
    setKind(proposal.kind);
    setContent(proposal.content);
  }, [proposal.id, proposal.revision, proposal.title, proposal.kind, proposal.content]);

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      let revision = proposal.revision;
      if (dirty) {
        const edited = await api.editMemoryProposal(proposal.id, {
          expectedRevision: revision,
          ...(title !== proposal.title ? { title } : {}),
          ...(kind !== proposal.kind ? { kind } : {}),
          ...(content !== proposal.content ? { content } : {}),
        });
        revision = edited.revision;
      }
      const result = await api.approveMemoryProposal(proposal.id, revision);
      onChanged?.(result.proposal);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.rejectMemoryProposal(proposal.id, proposal.revision, reason.trim() || undefined);
      onChanged?.(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="space-y-2 rounded-xl border p-3" data-testid="memory-proposal-card" data-status={proposal.status} data-proposal-id={proposal.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{tr("brain.proposal.review")}</h3>
        <span className="rounded-md bg-warning/10 px-2 py-0.5 text-xs" data-testid="memory-proposal-status">{tr(`brain.proposal.status.${proposal.status}`)}</span>
        <span className="text-xs text-muted-foreground">{tr(`brain.proposal.scope.${proposal.scope.kind}`)}</span>
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="memory-proposal-note">{tr("brain.proposal.not_memory")}</p>
      <p className="text-[11px]" data-testid="memory-proposal-claim">{tr(`brain.proposal.claim.${proposal.claim}`)}</p>
      <p className="text-[11px] text-muted-foreground"><span className="font-medium">{tr("brain.proposal.source")}: </span>{proposal.sourceRef}</p>
      {proposal.duplicateWarning && (
        <p className="text-[11px] text-warning" data-testid="memory-proposal-duplicate">{tr("brain.proposal.duplicate", { title: proposal.duplicateWarning.title })}</p>
      )}
      <label className="block text-xs">
        {tr("brain.proposal.title")}
        <input
          className="mt-1 w-full rounded-md border bg-transparent px-2 py-1 text-sm"
          value={title}
          disabled={!pending || busy}
          data-testid="memory-proposal-title"
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="block text-xs">
        {tr("brain.proposal.kind")}
        <select
          className="mt-1 w-full rounded-md border bg-transparent px-2 py-1 text-sm"
          value={kind}
          disabled={!pending || busy}
          data-testid="memory-proposal-kind"
          onChange={(event) => setKind(event.target.value as BrainKind)}
        >
          {KINDS.map((item) => <option key={item} value={item}>{tr(`brain.kind.${item}`)}</option>)}
        </select>
      </label>
      <label className="block text-xs">
        {tr("brain.proposal.content")}
        <Textarea className="mt-1" value={content} disabled={!pending || busy} rows={4} data-testid="memory-proposal-content" onChange={(event) => setContent(event.target.value)} />
      </label>
      {proposal.editedByOwner && <p className="text-[11px] text-muted-foreground" data-testid="memory-proposal-edited">{tr("brain.proposal.original")}: {proposal.original.title}</p>}
      {proposal.memoryId && (
        <p className="text-[11px]" data-testid="memory-proposal-memory" data-memory-id={proposal.memoryId}>
          {tr("brain.proposal.saved")}
          {" "}
          <button type="button" className="underline" data-testid="memory-proposal-open" onClick={() => onOpenBrain?.(proposal.scope.kind)}>{tr("brain.proposal.open")}</button>
        </p>
      )}
      {proposal.events && proposal.events.length > 0 && (
        <details data-testid="memory-proposal-history">
          <summary>{tr("brain.proposal.history")}</summary>
          <ul className="mt-1 space-y-1 text-[11px] text-muted-foreground">
            {proposal.events.map((event) => <li key={event.id}>{event.kind}: {event.detail}</li>)}
          </ul>
        </details>
      )}
      {error && <p role="alert" className="text-[11px] text-danger" data-testid="memory-proposal-error">{error}</p>}
      {pending && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy} data-testid="memory-proposal-approve" onClick={() => void approve()}>{tr("brain.proposal.approve")}</Button>
          <input
            className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs"
            value={reason}
            placeholder={tr("brain.proposal.reason")}
            disabled={busy}
            data-testid="memory-proposal-reason"
            onChange={(event) => setReason(event.target.value)}
          />
          <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="memory-proposal-reject" onClick={() => void reject()}>{tr("brain.proposal.reject")}</Button>
        </div>
      )}
      {proposal.decisionReason && !pending && <p className="text-[11px] text-muted-foreground">{proposal.decisionReason}</p>}
    </article>
  );
}
