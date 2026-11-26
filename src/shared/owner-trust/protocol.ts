/**
 * Canonical Owner authorization for one exact operation.
 * A boolean, a bearer token, and an environment flag are not fields of this
 * document. Verification uses the signature over these bytes.
 */
import { createHash } from "node:crypto";

export const OWNER_TRUST_SCHEMA = "forgeorbit-owner-trust-v1" as const;
export const CHALLENGE_TTL_MS = 2 * 60_000;
export const SINGLE_OPERATION_MAX_MS = 15 * 60_000;
export const MISSION_GRANT_MAX_MS = 24 * 60 * 60_000;
export const PRODUCTION_BUNDLE_ID = "app.forgeorbit";
export const QA_BUNDLE_ID = "app.forgeorbit.qa";

export const OPERATION_KINDS = ["single-operation", "bounded-mission", "resource-reauthorization", "project-envelope"] as const;
export type OwnerOperationKind = (typeof OPERATION_KINDS)[number];
export const TRUST_CLASSES = ["production", "qa-dev", "synthetic-test"] as const;
export type OwnerTrustClass = (typeof TRUST_CLASSES)[number];
export const KEY_PROTECTIONS = ["secure-enclave-user-presence", "keychain-user-presence", "synthetic-software", "unavailable"] as const;
export type OwnerKeyProtection = (typeof KEY_PROTECTIONS)[number];

export interface OwnerOperation {
  schema: typeof OWNER_TRUST_SCHEMA;
  requestId: string;
  kind: OwnerOperationKind;
  projectPath: string;
  taskId: string;
  missionId: string;
  missionRevision: string;
  role: "developer" | "reviewer" | "head-of-pm" | "policy-envelope";
  providerId: "codex" | "claude-code" | "policy-envelope";
  harnessId: string;
  modelId: string;
  accountId: string;
  mode: string;
  workspace: string;
  filesystem: "workspace-write" | "read-only" | "policy-envelope";
  terminalAllowed: boolean;
  browserAllowed: boolean;
  computerUseAllowed: boolean;
  gitRead: boolean;
  gitPublish: boolean;
  deploymentAllowed: boolean;
  envelopeId: string;
  envelopeDigest: string;
  policyRevision: string;
  scope: string;
  runId: string;
  attemptId: string;
  knownCost: string;
  costCoverage: "known-api" | "unknown-subscription" | "none";
  expiresAt: number;
  cancellationAvailable: true;
  externalProcess: boolean;
  taskStateDigest: string;
  missionStateDigest: string;
}

export interface OwnerProofPayload {
  schema: typeof OWNER_TRUST_SCHEMA;
  challenge: string;
  operationDigest: string;
  enrollmentId: string;
  applicationIdentity: string;
  issuedAt: number;
  expiresAt: number;
  scope: string;
  policyRevision: string;
  taskStateDigest: string;
  missionStateDigest: string;
}

export interface OwnerProof {
  schema: typeof OWNER_TRUST_SCHEMA;
  payload: OwnerProofPayload;
  signature: string;
}

const STRING_FIELDS = [
  "requestId", "projectPath", "taskId", "missionId", "missionRevision", "harnessId", "modelId", "accountId",
  "mode", "workspace", "envelopeId", "envelopeDigest", "policyRevision", "scope", "runId", "attemptId",
  "knownCost", "taskStateDigest", "missionStateDigest",
] as const;

const BOOL_FIELDS = [
  "terminalAllowed", "browserAllowed", "computerUseAllowed", "gitRead", "gitPublish", "deploymentAllowed", "externalProcess",
] as const;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) throw new Error("Owner authorization numbers must be safe integers.");
    return value;
  }
  if (typeof value === "string") {
    if (value.includes("\u0000")) throw new Error("Owner authorization text cannot contain NUL.");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("Owner authorization rejected a forbidden field.");
      out[key] = sortValue(source[key]);
    }
    return out;
  }
  throw new Error("Owner authorization contains an unsupported value.");
}

/** Rejects a raw JSON document that repeats an object key. */
export function assertNoDuplicateKeys(text: string): void {
  const stack: Array<Set<string> | null> = [];
  let index = 0;
  const fail = () => { throw new Error("Owner authorization JSON is ambiguous."); };
  const peek = () => text[index];
  const skip = () => { while (index < text.length && text[index]!.charCodeAt(0) <= 32) index += 1; };
  const parse = (): void => {
    skip();
    const char = peek();
    if (char === "{") {
      index += 1;
      const keys = new Set<string>();
      stack.push(keys);
      skip();
      if (peek() === "}") { index += 1; stack.pop(); return; }
      for (;;) {
        skip();
        if (peek() !== "\"") fail();
        const key = readString();
        if (keys.has(key)) fail();
        keys.add(key);
        skip();
        if (peek() !== ":") fail();
        index += 1;
        parse();
        skip();
        if (peek() === "}") { index += 1; stack.pop(); return; }
        if (peek() !== ",") fail();
        index += 1;
      }
    }
    if (char === "[") {
      index += 1;
      stack.push(null);
      skip();
      if (peek() === "]") { index += 1; stack.pop(); return; }
      for (;;) {
        parse();
        skip();
        if (peek() === "]") { index += 1; stack.pop(); return; }
        if (peek() !== ",") fail();
        index += 1;
      }
    }
    if (char === "\"") { readString(); return; }
    if (char === "t" || char === "f" || char === "n" || char === "-" || (char !== undefined && char >= "0" && char <= "9")) {
      const start = index;
      while (index < text.length && !",}]".includes(text[index]!) && text[index]!.charCodeAt(0) > 32) index += 1;
      if (index === start) fail();
      return;
    }
    fail();
  };
  const readString = (): string => {
    if (peek() !== "\"") fail();
    index += 1;
    let out = "";
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\"") { index += 1; return out; }
      if (char === "\\") {
        index += 1;
        const esc = text[index];
        if (esc === undefined) fail();
        out += esc === "u" ? text.slice(index, index + 5) : esc;
        index += esc === "u" ? 5 : 1;
        continue;
      }
      if (char.charCodeAt(0) < 32) fail();
      out += char;
      index += 1;
    }
    fail();
    return out;
  };
  parse();
  skip();
  if (index !== text.length) fail();
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || trimmed.includes("\u0000")) return null;
  return trimmed;
}

export function expectedScope(operation: Pick<OwnerOperation, "kind" | "role" | "providerId" | "accountId" | "modelId" | "missionId" | "policyRevision">): string {
  if (operation.kind === "bounded-mission") return `mission:${operation.missionId}:${operation.policyRevision}`;
  if (operation.kind === "project-envelope") return `project:${operation.missionId}:${operation.policyRevision}`;
  return `single:${operation.role}:${operation.providerId}:${operation.accountId}:${operation.modelId}`;
}

export function parseOwnerOperation(raw: unknown, now = Date.now(), options?: { skipWindow?: boolean }): { ok: true; operation: OwnerOperation; canonical: string; digest: string } | { ok: false; code: string; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "owner-proof-invalid", reason: "The operation is not an object. An approved flag is not an operation." };
  }
  const body = raw as Record<string, unknown>;
  if (body.schema !== OWNER_TRUST_SCHEMA) return { ok: false, code: "owner-proof-invalid", reason: "The operation schema is not the Owner trust document." };
  if (!OPERATION_KINDS.includes(body.kind as OwnerOperationKind)) return { ok: false, code: "owner-proof-invalid", reason: "The operation kind is not recognized." };
  const kind = body.kind as OwnerOperationKind;
  const operation = { schema: OWNER_TRUST_SCHEMA, kind } as OwnerOperation;
  for (const field of STRING_FIELDS) {
    const value = text(body[field], field.endsWith("Digest") || field === "missionRevision" || field === "envelopeDigest" ? 128 : 2000);
    if (!value) return { ok: false, code: "owner-proof-invalid", reason: `The operation is missing ${field}.` };
    operation[field] = value;
  }
  if (body.role !== "developer" && body.role !== "reviewer" && body.role !== "head-of-pm" && body.role !== "policy-envelope") {
    return { ok: false, code: "owner-proof-invalid", reason: "The operation role is not recognized." };
  }
  if (body.providerId !== "codex" && body.providerId !== "claude-code" && body.providerId !== "policy-envelope") {
    return { ok: false, code: "owner-provider-blocked", reason: "Only Codex and Claude can be named by an Owner execution proof. Cursor and DeepSeek stay blocked." };
  }
  if (typeof body.modelId === "string" && /deepseek|cursor/i.test(body.modelId) && body.providerId !== "policy-envelope") {
    return { ok: false, code: "owner-provider-blocked", reason: "Cursor and DeepSeek stay blocked." };
  }
  if (body.filesystem !== "workspace-write" && body.filesystem !== "read-only" && body.filesystem !== "policy-envelope") {
    return { ok: false, code: "owner-proof-invalid", reason: "The filesystem permission is not recognized." };
  }
  if (body.costCoverage !== "known-api" && body.costCoverage !== "unknown-subscription" && body.costCoverage !== "none") {
    return { ok: false, code: "owner-proof-invalid", reason: "The cost coverage is not recognized." };
  }
  operation.role = body.role;
  operation.providerId = body.providerId;
  operation.filesystem = body.filesystem;
  operation.costCoverage = body.costCoverage;
  for (const field of BOOL_FIELDS) {
    if (typeof body[field] !== "boolean") return { ok: false, code: "owner-proof-invalid", reason: `The operation is missing ${field}.` };
    operation[field] = body[field];
  }
  if (body.cancellationAvailable !== true) return { ok: false, code: "owner-proof-invalid", reason: "Cancellation must remain available." };
  operation.cancellationAvailable = true;
  if (typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt)) {
    return { ok: false, code: "owner-proof-invalid", reason: "The expiration is not a timestamp." };
  }
  operation.expiresAt = body.expiresAt;
  if (operation.terminalAllowed || operation.browserAllowed || operation.computerUseAllowed || operation.gitPublish || operation.deploymentAllowed) {
    return { ok: false, code: "owner-privileged-excluded", reason: "Terminal, browser, Computer Use, git publication, and deployment are not included in this authorization." };
  }
  if (kind === "project-envelope") {
    // One project, named explicitly. The envelope's fields (harnesses, accounts, models, delivery, budget) are in the
    // digest-bound `envelopeDigest` and shown in the readable fields; the role, provider, model and filesystem of any
    // single launch are decided per launch against it, never named here.
    if (operation.role !== "policy-envelope" || operation.providerId !== "policy-envelope" || operation.modelId !== "policy-envelope" || operation.filesystem !== "policy-envelope" || operation.taskId !== "policy-envelope" || operation.runId !== "policy-envelope") {
      return { ok: false, code: "owner-envelope", reason: "A project envelope names the project's rules. It does not name one unrestricted future operation." };
    }
    if (operation.projectPath === "policy-envelope" || operation.workspace === "policy-envelope" || !operation.missionId.startsWith("handsoff:")) {
      return { ok: false, code: "owner-envelope", reason: "A project envelope names exactly one project." };
    }
    if (operation.gitRead) return { ok: false, code: "owner-sandbox", reason: "A project envelope does not include git read access." };
  } else if (kind === "bounded-mission") {
    if (operation.role !== "policy-envelope" || operation.providerId !== "policy-envelope" || operation.accountId !== "policy-envelope" || operation.modelId !== "policy-envelope" || operation.filesystem !== "policy-envelope" || operation.taskId !== "policy-envelope") {
      return { ok: false, code: "owner-envelope", reason: "A bounded mission names the policy envelope. It does not name one unrestricted future operation." };
    }
  } else {
    if (operation.role === "policy-envelope" || operation.providerId === "policy-envelope" || operation.filesystem === "policy-envelope") {
      return { ok: false, code: "owner-operation-mismatch", reason: "A single operation must name the role, provider, and filesystem." };
    }
    if (operation.role === "reviewer" && operation.filesystem !== "read-only") {
      return { ok: false, code: "owner-sandbox", reason: "A Reviewer operation is read-only." };
    }
    if (operation.role === "head-of-pm" && operation.filesystem !== "read-only") {
      return { ok: false, code: "owner-sandbox", reason: "A Head of PM isolated turn is read-only." };
    }
    if (operation.role === "head-of-pm" && operation.gitRead) {
      return { ok: false, code: "owner-sandbox", reason: "A Head of PM isolated turn cannot access repository git state." };
    }
    if (operation.role === "developer" && operation.filesystem !== "workspace-write") {
      return { ok: false, code: "owner-sandbox", reason: "A Developer operation is workspace-write." };
    }
  }
  if (operation.scope !== expectedScope(operation)) {
    return { ok: false, code: "owner-operation-mismatch", reason: "The scope does not match the operation." };
  }
  const max = kind === "bounded-mission" || kind === "project-envelope" ? MISSION_GRANT_MAX_MS : SINGLE_OPERATION_MAX_MS;
  if (!options?.skipWindow && (operation.expiresAt <= now || operation.expiresAt > now + max)) {
    return { ok: false, code: "owner-challenge-expired", reason: "The operation validity interval is closed or too long." };
  }
  if ("approved" in body) return { ok: false, code: "owner-proof-invalid", reason: "An approved field is not Owner authorization." };
  const canonical = canonicalize(operation);
  return { ok: true, operation, canonical, digest: sha256Hex(canonical) };
}

export function parseOwnerProof(raw: unknown): { ok: true; proof: OwnerProof } | { ok: false; code: string; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "owner-proof-invalid", reason: "The proof is not a signed document." };
  }
  const body = raw as Record<string, unknown>;
  if (body.approved === true && !body.payload) {
    return { ok: false, code: "owner-proof-invalid", reason: "An approved flag is not a signature." };
  }
  const payload = body.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "owner-proof-invalid", reason: "The proof payload is missing." };
  }
  const source = payload as Record<string, unknown>;
  if (source.schema !== OWNER_TRUST_SCHEMA) return { ok: false, code: "owner-proof-invalid", reason: "The proof schema is not recognized." };
  const signature = text(body.signature, 512);
  const challenge = text(source.challenge, 128);
  const operationDigest = text(source.operationDigest, 128);
  const enrollmentId = text(source.enrollmentId, 80);
  const applicationIdentity = text(source.applicationIdentity, 200);
  const scope = text(source.scope, 300);
  const policyRevision = text(source.policyRevision, 80);
  const taskStateDigest = text(source.taskStateDigest, 128);
  const missionStateDigest = text(source.missionStateDigest, 128);
  if (!signature || !challenge || !operationDigest || !enrollmentId || !applicationIdentity || !scope || !policyRevision || !taskStateDigest || !missionStateDigest) {
    return { ok: false, code: "owner-proof-invalid", reason: "The proof is missing a required field." };
  }
  if (typeof source.issuedAt !== "number" || typeof source.expiresAt !== "number") {
    return { ok: false, code: "owner-proof-invalid", reason: "The proof timestamps are missing." };
  }
  const proof: OwnerProof = {
    schema: OWNER_TRUST_SCHEMA,
    signature,
    payload: {
      schema: OWNER_TRUST_SCHEMA,
      challenge,
      operationDigest,
      enrollmentId,
      applicationIdentity,
      issuedAt: source.issuedAt,
      expiresAt: source.expiresAt,
      scope,
      policyRevision,
      taskStateDigest,
      missionStateDigest,
    },
  };
  return { ok: true, proof };
}

export function proofMessage(payload: OwnerProofPayload): string {
  return canonicalize(payload);
}

export function childInsideEnvelope(parent: OwnerOperation, child: OwnerOperation): string | null {
  if (parent.kind !== "bounded-mission") return "The parent grant is not a bounded mission.";
  if (child.kind === "bounded-mission") return "A bounded grant does not authorize another envelope.";
  if (child.role === "head-of-pm") return "A bounded mission grant does not authorize a Head of PM turn.";
  if (child.missionId !== parent.missionId || child.policyRevision !== parent.policyRevision || child.envelopeDigest !== parent.envelopeDigest) {
    return "The child operation leaves the approved mission envelope.";
  }
  if (parent.projectPath !== "policy-envelope" && child.projectPath !== parent.projectPath) return "The child operation leaves the approved project.";
  if (parent.workspace !== "policy-envelope" && child.workspace !== parent.workspace) return "The child operation leaves the approved workspace.";
  if (child.expiresAt > parent.expiresAt) return "The child operation outlives the approved grant.";
  if (child.terminalAllowed || child.browserAllowed || child.computerUseAllowed || child.gitPublish || child.deploymentAllowed) {
    return "The child operation adds a privileged permission.";
  }
  if (child.gitRead !== parent.gitRead) return "The child operation changes git read permission.";
  return null;
}
