/** Organizational attribution is never provider/account evidence or permission. */
export interface HeadSnapshot {
  employeeId: string;
  name: string;
  kind: "head";
  jobTitle: string;
  roleCategory: string;
}
export interface HeadPortfolioBinding {
  sessionId: "global";
  revision: number;
  employeeId: string | null;
  status: "bound" | "unbound" | "invalid";
  head: HeadSnapshot | null;
  employeeStatus: string | null;
  reason: string | null;
}
export interface PortfolioTurnAttribution {
  sessionId: "global";
  turnId: string;
  bindingRevision: number;
  bindingStatus: HeadPortfolioBinding["status"];
  head: HeadSnapshot | null;
  scope: { kind: "portfolio"; projectPaths: string[] };
  capturedAt: number;
  provenance: "owner-confirmed-binding" | "legacy-unattributed";
}
/** Only stored server-generated shapes qualify. Missing legacy data stays absent. */
export function storedPortfolioAttribution(value: unknown): PortfolioTurnAttribution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as PortfolioTurnAttribution;
  if (v.sessionId !== "global" || typeof v.turnId !== "string" || !Number.isInteger(v.bindingRevision)
    || !["bound", "unbound", "invalid"].includes(v.bindingStatus) || !Number.isFinite(v.capturedAt)
    || v.scope?.kind !== "portfolio" || !Array.isArray(v.scope.projectPaths) || !v.scope.projectPaths.every(p => typeof p === "string")) return undefined;
  if (v.head !== null && (!v.head || v.head.kind !== "head" || typeof v.head.employeeId !== "string"
    || typeof v.head.name !== "string" || typeof v.head.jobTitle !== "string" || typeof v.head.roleCategory !== "string")) return undefined;
  if (v.provenance !== (v.head ? "owner-confirmed-binding" : "legacy-unattributed") || (v.head !== null) !== (v.bindingStatus === "bound")) return undefined;
  return v;
}
