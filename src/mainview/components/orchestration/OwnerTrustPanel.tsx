import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { getLocale, t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { TechnicalDetails, TechnicalDisclosure, type TechnicalRow } from "@/components/ui/technical-details";
import {
  allowedLabel,
  costCoverageText,
  filesystemAccessText,
  isBuildLevelOwnerState,
  operationAccountText,
  ownerCodeText,
  ownerStateSummary,
  yesNoLabel,
} from "@/lib/status-presenters";

interface TrustStatus {
  code: string;
  reason: string;
  state?: string;
  expectedProductionBundleId?: string;
  application: { bundleId: string | null; trustClass: string; adhoc: boolean; signed: boolean; teamId?: string | null; certSha256?: string | null };
  helper?: { ok: boolean; code: string; identifier: string | null; path: string | null };
  secureEnclave?: string;
  secureEnclaveEnrolled?: boolean;
  enrollmentState?: string;
  userAuthenticationAvailable?: boolean;
  userAuthenticated?: boolean;
  providerExecutionEligible?: boolean;
  blockingReason?: string;
  operation?: {
    projectPath: string;
    taskId: string;
    taskTitle: string;
    missionId: string;
    missionTitle: string;
    providerId: string;
    modelId: string;
    accountId: string;
    employeeRole: string;
    employeeJobTitle: string;
    mode: string;
    workspace: string;
    filesystem: string;
    terminalAllowed: boolean;
    browserAllowed: boolean;
    computerUseAllowed: boolean;
    gitRead: boolean;
    gitPublish: boolean;
    deploymentAllowed: boolean;
    scope: string;
    expiresAt: number;
    knownCost: string;
    costCoverage: string;
    externalProcess: boolean;
    cancellationAvailable: boolean;
  } | null;
}

/**
 * Shows the backend operation in plain words and keeps the signing diagnostics in technical details.
 * The button asks the embedded helper to review that operation.
 * The page does not sign and does not send a trusted proof.
 */
/** The exact mission (and optionally task) a person came from. When present, only that operation is shown or reviewed. */
export interface OwnerReviewContext {
  missionId: string;
  missionTitle?: string;
  taskId?: string;
  taskTitle?: string;
}

/** True when the pending operation is the one the context names. A context never selects another operation. */
export function operationMatchesContext(
  operation: { missionId: string; taskId: string } | null | undefined,
  context: OwnerReviewContext | null | undefined,
): boolean {
  if (!context) return true;
  if (!operation) return false;
  if (operation.missionId !== context.missionId) return false;
  return !context.taskId || operation.taskId === context.taskId;
}

export function OwnerTrustPanel({ context = null }: { context?: OwnerReviewContext | null }) {
  useUILocale();
  const [status, setStatus] = useState<TrustStatus | null>(null);
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  // True when the status or review call itself failed (the page never got a backend answer).
  const [unavailable, setUnavailable] = useState(false);
  async function refreshStatus(preserveReviewResult = false) {
    try {
      const next = await api.ownerTrustStatus();
      setStatus(next);
      if (!preserveReviewResult) {
        setCode(next.code);
        setReason(next.blockingReason || next.reason);
      }
    } catch (error) {
      if (!preserveReviewResult) {
        setUnavailable(true);
        setCode("owner-proof-invalid");
        setReason(error instanceof Error ? error.message : "");
      }
    }
  }
  useEffect(() => {
    void refreshStatus();
    const onFocus = () => { void refreshStatus(true); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  async function review() {
    if (reviewBlockedByContext) return;
    try {
      const result = await api.ownerTrustReview({ locale: getLocale() === "ru" ? "ru" : "en" });
      setUnavailable(false);
      setCode(result.code);
      setReason(result.reason);
      void refreshStatus(true);
    } catch (error) {
      setUnavailable(true);
      setCode("owner-proof-invalid");
      setReason(error instanceof Error ? error.message : "");
    }
  }
  const state = status?.state ?? "development-or-qa";
  const stateKey = `ownerTrust.state.${state}` as TranslationKey;
  const actionKey = `ownerTrust.action.${state}` as TranslationKey;
  const pendingOperation = status?.operation;
  // With a mission context, an operation that belongs elsewhere is neither shown nor reviewable from here.
  const operationMatches = operationMatchesContext(pendingOperation, context);
  const operation = operationMatches ? pendingOperation : null;
  const reviewBlockedByContext = !!context && !operationMatches;
  const buildLevel = isBuildLevelOwnerState(state);
  const executionAllowed = status?.providerExecutionEligible === true;

  const statusRows: TechnicalRow[] = [
    { label: tr("ownerTrust.blocked"), value: tr(stateKey), testId: "owner-trust-state-detail" },
    { label: tr("ownerTrust.bundle"), value: status?.application.bundleId || status?.application.trustClass || tr("m0.notSet"), testId: "owner-trust-bundle" },
    { label: tr("ownerTrust.expected"), value: status?.expectedProductionBundleId || "app.forgeorbit", testId: "owner-trust-expected" },
    { label: tr("ownerTrust.team"), value: status?.application.certSha256 || tr("m0.notSet"), testId: "owner-trust-team" },
    { label: tr("ownerTrust.helper"), value: status?.helper?.identifier || status?.helper?.code || tr("m0.notSet"), testId: "owner-trust-helper" },
    { label: tr("ownerTrust.enclave"), value: status?.secureEnclave === "hardware-present" ? (status.secureEnclaveEnrolled ? tr("m0.enrollment.active") : tr("ownerTrust.hardwareOnly")) : tr("ownerTrust.state.secure-enclave-unavailable"), testId: "owner-trust-enclave" },
    { label: tr("ownerTrust.enrollment"), value: status?.enrollmentState ?? "none", testId: "owner-trust-enrollment" },
    { label: tr("ownerTrust.authentication"), value: status?.userAuthenticated ? tr("ownerTrust.authorized") : tr("ownerTrust.notAuthenticated"), testId: "owner-trust-authentication" },
    { label: tr("ownerTrust.channel"), value: code, testId: "owner-trust-code" },
    { label: tr("ownerTrust.execution"), value: status?.providerExecutionEligible ? tr("ownerTrust.started") : tr("ownerTrust.blocked"), testId: "owner-trust-execution-detail", noCopy: true },
    { label: tr("ownerTrust.action"), value: tr(actionKey), testId: "owner-trust-action-detail", noCopy: true },
    { label: tr("ownerTrust.blocker"), value: reason, testId: "owner-trust-reason" },
  ];
  // The backend sends the same sentence twice when there is no separate blocking reason; show it once.
  if (status?.blockingReason && status.blockingReason !== reason) statusRows.push({ label: tr("ownerTrust.blocker"), value: status.blockingReason, testId: "owner-trust-blocker" });
  if (operation) {
    statusRows.push(
      { label: tr("ownerTrust.project"), value: operation.projectPath },
      { label: tr("ownerTrust.task"), value: operation.taskId },
      { label: tr("ownerTrust.mission"), value: operation.missionId },
      { label: tr("ownerTrust.provider"), value: operation.providerId },
      { label: tr("ownerTrust.model"), value: operation.modelId },
      { label: tr("ownerTrust.account"), value: operation.accountId },
      { label: tr("ownerTrust.employee"), value: `${operation.employeeJobTitle} · ${operation.employeeRole}` },
      { label: tr("ownerTrust.mode"), value: operation.mode },
      { label: tr("ownerTrust.workspace"), value: operation.workspace },
      { label: tr("ownerTrust.filesystem"), value: operation.filesystem },
      { label: tr("ownerTrust.scope"), value: `${operation.scope} · ${operation.expiresAt}` },
      { label: tr("ownerTrust.cost"), value: operation.knownCost },
      { label: tr("ownerTrust.subscription"), value: operation.costCoverage },
    );
  }

  const stateSummary = ownerStateSummary(state);
  // The code sentence follows the freshest answer (a review result or a failed call). It is shown only when it adds something.
  const codeSummary = ownerCodeText(unavailable ? "statusUnavailable" : code);
  // One "why" line while blocked, and only when it says more than the status line above it.
  const showWhy = !executionAllowed && codeSummary !== stateSummary;

  return (
    <section className="space-y-3" data-testid="owner-trust-panel">
      <h2 className="text-sm font-medium">{tr("ownerTrust.title")}</h2>
      {context && (
        <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-xs" data-testid="owner-trust-context">
          <p className="font-medium">{tr("settings.owner.context_mission", { mission: context.missionTitle || context.missionId })}</p>
          {context.taskId && <p>{tr("settings.owner.context_task", { task: context.taskTitle || context.taskId })}</p>}
          <p className="text-muted-foreground">{tr("settings.owner.context_note")}</p>
          {reviewBlockedByContext && (
            <p className="pt-1 text-warning" role="status" data-testid="owner-trust-context-mismatch">
              {pendingOperation ? tr("settings.owner.other_operation") : tr("settings.owner.none_for_mission")}
            </p>
          )}
        </div>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{tr("ownerPlain.summary")}</dt>
        <dd data-testid="owner-trust-state">{stateSummary}</dd>
        <dt className="text-muted-foreground">{tr("ownerPlain.allowedNow")}</dt>
        <dd data-testid="owner-trust-execution" className={executionAllowed ? "text-success" : "text-warning"}>
          {executionAllowed ? tr("ownerTrust.started") : tr("ownerPlain.blockedNow")}
        </dd>
        {showWhy && (
          <>
            <dt className="text-muted-foreground">{tr("ownerPlain.why")}</dt>
            <dd role="status" data-testid="owner-trust-summary">{codeSummary}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{tr("ownerPlain.next")}</dt>
        <dd data-testid="owner-trust-action">{buildLevel ? tr("ownerPlain.buildAction") : tr(actionKey)}</dd>
      </dl>
      <div data-testid="owner-trust-operation">
        <h3 className="text-xs font-medium">{tr("ownerPlain.whatYouApprove")}</h3>
        {operation ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            <dt>{tr("ownerTrust.task")}</dt><dd>{operation.taskTitle}</dd>
            <dt>{tr("ownerTrust.mission")}</dt><dd>{operation.missionId === "none" ? tr("m0.none") : (operation.missionTitle || operation.missionId)}</dd>
            <dt>{tr("ownerPlain.employee")}</dt><dd>{operation.employeeJobTitle || operation.employeeRole}</dd>
            <dt>{tr("ownerTrust.account")}</dt><dd>{operationAccountText(operation.accountId)}</dd>
            <dt>{tr("ownerPlain.filesAccess")}</dt><dd>{filesystemAccessText(operation.filesystem)}</dd>
            <dt>{tr("ownerTrust.terminal")}</dt><dd>{allowedLabel(operation.terminalAllowed)}</dd>
            <dt>{tr("ownerTrust.browser")}</dt><dd>{allowedLabel(operation.browserAllowed)}</dd>
            <dt>{tr("ownerTrust.computer")}</dt><dd>{allowedLabel(operation.computerUseAllowed)}</dd>
            <dt>{tr("ownerPlain.gitRead")}</dt><dd>{allowedLabel(operation.gitRead)}</dd>
            <dt>{tr("ownerPlain.gitPublish")}</dt><dd>{allowedLabel(operation.gitPublish)}</dd>
            <dt>{tr("ownerTrust.deployment")}</dt><dd>{allowedLabel(operation.deploymentAllowed)}</dd>
            <dt>{tr("ownerPlain.cost")}</dt><dd>{operation.costCoverage === "known-api" ? `${costCoverageText(operation.costCoverage)}: ${operation.knownCost}` : costCoverageText(operation.costCoverage)}</dd>
            <dt>{tr("ownerTrust.external")}</dt><dd>{yesNoLabel(operation.externalProcess)}</dd>
            <dt>{tr("ownerTrust.cancelAvailable")}</dt><dd>{allowedLabel(operation.cancellationAvailable)}</dd>
          </dl>
        ) : <p className="text-xs text-muted-foreground">{tr("ownerTrust.none")}</p>}
      </div>
      {!showWhy && codeSummary !== stateSummary && <p className="text-xs" role="status" data-testid="owner-trust-summary">{codeSummary}</p>}
      <p className="text-xs text-muted-foreground" data-testid="owner-trust-no-process">{tr("ownerTrust.noProcess")}</p>
      <button type="button" disabled={reviewBlockedByContext} className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" data-testid="owner-trust-review" onClick={() => void review()}>
        {tr("ownerTrust.review")}
      </button>
      <TechnicalDisclosure summary={tr("ownerPlain.howItWorks")} testId="owner-trust-how">
        <p className="text-muted-foreground" data-testid="owner-trust-intro">{tr("ownerTrust.intro")}</p>
      </TechnicalDisclosure>
      <TechnicalDetails rows={statusRows} summary={tr("ownerPlain.moreDetails")} testId="owner-trust-details" />
    </section>
  );
}
