/** Server-side digests for the project envelope. Kept apart from the webview-safe model: these use node:crypto. */
import { canonicalize, sha256Hex } from "./owner-trust/protocol.ts";
import type { HandsoffEnvelope } from "./handsoff-authorization.ts";

export function envelopeDigest(envelope: HandsoffEnvelope): string {
  return sha256Hex(canonicalize(envelope));
}

export function projectIdentityOf(projectPath: string, addedAt: number): string {
  return sha256Hex(canonicalize({ addedAt, projectPath }));
}

