/**
 * Durable Owner-trust records. Private keys are not stored.
 * A copied database fails closed until a new enrollment on that profile.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { sha256Hex, type OwnerKeyProtection, type OwnerTrustClass } from "../../shared/owner-trust/protocol.ts";

export const OWNER_TRUST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS owner_trust_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_dir_hash TEXT NOT NULL,
  machine_binding TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS owner_trust_enrollments (
  id TEXT PRIMARY KEY,
  trust_class TEXT NOT NULL,
  application_identity TEXT NOT NULL,
  public_key_spki TEXT NOT NULL UNIQUE,
  key_protection TEXT NOT NULL,
  authority_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  label TEXT NOT NULL,
  signing_cert_sha256 TEXT
);
CREATE TABLE IF NOT EXISTS owner_trust_challenges (
  id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  operation_digest TEXT NOT NULL,
  operation_canonical TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_trust_grants (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE,
  enrollment_id TEXT NOT NULL,
  operation_digest TEXT NOT NULL,
  operation_canonical TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  task_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_trust_grant_uses (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL,
  run_id TEXT NOT NULL,
  operation_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (grant_id, task_id, role, run_id)
);
CREATE TABLE IF NOT EXISTS owner_trust_decisions (
  id TEXT PRIMARY KEY,
  challenge_id TEXT,
  grant_id TEXT,
  enrollment_id TEXT,
  operation_digest TEXT NOT NULL,
  code TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface EnrollmentRow {
  id: string;
  trust_class: OwnerTrustClass;
  application_identity: string;
  public_key_spki: string;
  key_protection: OwnerKeyProtection;
  authority_state: string;
  created_at: number;
  rotated_at: number | null;
  label: string;
  signing_cert_sha256: string | null;
}

export interface ChallengeRow {
  id: string;
  nonce_hash: string;
  nonce: string;
  operation_digest: string;
  operation_canonical: string;
  enrollment_id: string;
  expires_at: number;
  consumed_at: number | null;
  status: string;
  created_at: number;
}

export interface GrantRow {
  id: string;
  challenge_id: string;
  enrollment_id: string;
  operation_digest: string;
  operation_canonical: string;
  status: string;
  expires_at: number;
  consumed_at: number | null;
  task_id: string;
  mission_id: string;
  project_path: string;
  created_at: number;
}

export function ensureOwnerTrustSchema(database: Database): void {
  database.exec(OWNER_TRUST_SCHEMA_SQL);
  const columns = database.query<{ name: string }, []>("PRAGMA table_info(owner_trust_enrollments)").all();
  if (columns.length > 0 && !columns.some((column) => column.name === "signing_cert_sha256")) {
    database.exec("ALTER TABLE owner_trust_enrollments ADD COLUMN signing_cert_sha256 TEXT");
  }
}

export function profileHashes(dataDir: string, machineId: string): { dataDirHash: string; machineBinding: string } {
  let dir = dataDir;
  try { dir = realpathSync(dataDir); } catch { /* the directory may not exist yet */ }
  return { dataDirHash: sha256Hex(dir), machineBinding: sha256Hex(machineId) };
}

export function reconcileProfile(database: Database, dataDir: string, machineId: string): { sealed: boolean } {
  ensureOwnerTrustSchema(database);
  const hashes = profileHashes(dataDir, machineId);
  const row = database.query<{ data_dir_hash: string; machine_binding: string; sealed: number }, []>(
    "SELECT data_dir_hash, machine_binding, sealed FROM owner_trust_profile WHERE id = 1",
  ).get();
  if (!row) {
    database.run(
      "INSERT INTO owner_trust_profile (id, data_dir_hash, machine_binding, sealed) VALUES (1, ?, ?, 0)",
      [hashes.dataDirHash, hashes.machineBinding],
    );
    return { sealed: false };
  }
  if (row.data_dir_hash !== hashes.dataDirHash || row.machine_binding !== hashes.machineBinding) {
    database.run("UPDATE owner_trust_profile SET sealed = 1 WHERE id = 1");
    database.run("UPDATE owner_trust_enrollments SET authority_state = 'restored-inactive', rotated_at = COALESCE(rotated_at, 0) WHERE authority_state = 'active'");
    return { sealed: true };
  }
  return { sealed: row.sealed === 1 };
}

function hasTable(database: Database, name: string): boolean {
  return database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

/**
 * Seal a restored database so none of its Owner enrollments keeps authority.
 *
 * This must never create or alter schema. A restored snapshot is opened later
 * by the normal startup, whose migrations own the Owner-trust tables
 * (136_owner_trust) and the `signing_cert_sha256` column (137). Creating them
 * here, ahead of the migrations, made 136 a no-op and 137's ALTER fail with
 * "duplicate column name" on every snapshot older than 137 (FO-UPGRADE02).
 *
 * Nothing is lost by leaving an older snapshot alone: before 136 no enrollment
 * could exist, so there is no authority to carry over. After the migrations
 * create the tables, startup (`reconcileProfile`) binds the profile to its new
 * folder, and an enrollment needs a fresh native Owner proof.
 */
export function sealOwnerTrustDatabase(database: Database): number {
  if (hasTable(database, "owner_trust_profile")) {
    database.run("UPDATE owner_trust_profile SET sealed = 1 WHERE id = 1");
  }
  if (!hasTable(database, "owner_trust_enrollments")) return 0;
  const result = database.run(
    "UPDATE owner_trust_enrollments SET authority_state = 'restored-inactive' WHERE authority_state = 'active'",
  );
  return result.changes;
}

export function sealRestoredOwnerTrustFile(dbPath: string): void {
  try {
    const database = new Database(dbPath);
    try { sealOwnerTrustDatabase(database); } finally { database.close(); }
  } catch {
    // A snapshot without a readable database cannot gain Owner authority.
  }
}

export class OwnerTrustStore {
  constructor(readonly database: Database) {
    ensureOwnerTrustSchema(database);
  }

  insertEnrollment(input: {
    trustClass: OwnerTrustClass;
    applicationIdentity: string;
    publicKeySpki: string;
    keyProtection: OwnerKeyProtection;
    label: string;
    now: number;
    id?: string;
    signingCertSha256?: string | null;
  }): EnrollmentRow {
    const id = input.id ?? randomUUID();
    this.database.run(
      `INSERT INTO owner_trust_enrollments
        (id, trust_class, application_identity, public_key_spki, key_protection, authority_state, created_at, rotated_at, label, signing_cert_sha256)
       VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)`,
      [id, input.trustClass, input.applicationIdentity, input.publicKeySpki, input.keyProtection, input.now, input.label, input.signingCertSha256 ?? null],
    );
    return this.enrollment(id)!;
  }

  /**
   * Pins that still hold authority. A removed (revoked) or rotated row is
   * historical: after the Owner explicitly revokes it, a deliberately replaced
   * certificate may enroll a fresh Secure Enclave key. While a row is active,
   * any different certificate is refused.
   */
  activePinnedCertificates(): string[] {
    return this.database.query<{ signing_cert_sha256: string }, []>(
      "SELECT DISTINCT signing_cert_sha256 FROM owner_trust_enrollments WHERE signing_cert_sha256 IS NOT NULL AND authority_state = 'active'",
    ).all().map((row) => row.signing_cert_sha256);
  }

  enrollment(id: string): EnrollmentRow | null {
    return this.database.query<EnrollmentRow, [string]>("SELECT * FROM owner_trust_enrollments WHERE id = ?").get(id) ?? null;
  }

  enrollmentByKey(publicKeySpki: string): EnrollmentRow | null {
    return this.database.query<EnrollmentRow, [string]>("SELECT * FROM owner_trust_enrollments WHERE public_key_spki = ?").get(publicKeySpki) ?? null;
  }

  activeByClass(trustClass: OwnerTrustClass): EnrollmentRow[] {
    return this.database.query<EnrollmentRow, [string]>(
      "SELECT * FROM owner_trust_enrollments WHERE trust_class = ? AND authority_state = 'active' ORDER BY created_at",
    ).all(trustClass);
  }

  setEnrollmentState(id: string, state: string, now: number): void {
    this.database.run("UPDATE owner_trust_enrollments SET authority_state = ?, rotated_at = ? WHERE id = ?", [state, now, id]);
  }

  insertChallenge(input: {
    nonceHash: string;
    nonce: string;
    operationDigest: string;
    operationCanonical: string;
    enrollmentId: string;
    expiresAt: number;
    now: number;
  }): ChallengeRow {
    const id = randomUUID();
    this.database.run(
      `INSERT INTO owner_trust_challenges
        (id, nonce_hash, nonce, operation_digest, operation_canonical, enrollment_id, expires_at, consumed_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'open', ?)`,
      [id, input.nonceHash, input.nonce, input.operationDigest, input.operationCanonical, input.enrollmentId, input.expiresAt, input.now],
    );
    return this.challenge(id)!;
  }

  challenge(id: string): ChallengeRow | null {
    return this.database.query<ChallengeRow, [string]>("SELECT * FROM owner_trust_challenges WHERE id = ?").get(id) ?? null;
  }

  challengeByNonce(nonceHash: string): ChallengeRow | null {
    return this.database.query<ChallengeRow, [string]>("SELECT * FROM owner_trust_challenges WHERE nonce_hash = ?").get(nonceHash) ?? null;
  }

  grant(id: string): GrantRow | null {
    return this.database.query<GrantRow, [string]>("SELECT * FROM owner_trust_grants WHERE id = ?").get(id) ?? null;
  }

  grantByChallenge(challengeId: string): GrantRow | null {
    return this.database.query<GrantRow, [string]>("SELECT * FROM owner_trust_grants WHERE challenge_id = ?").get(challengeId) ?? null;
  }

  recordDecision(input: {
    challengeId: string | null;
    grantId: string | null;
    enrollmentId: string | null;
    operationDigest: string;
    code: string;
    decision: "approved" | "refused" | "consumed" | "revoked" | "enrolled";
    now: number;
  }): string {
    const id = randomUUID();
    this.database.run(
      `INSERT INTO owner_trust_decisions
        (id, challenge_id, grant_id, enrollment_id, operation_digest, code, decision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.challengeId, input.grantId, input.enrollmentId, input.operationDigest, input.code, input.decision, input.now],
    );
    return id;
  }

  decisions(): Array<{ id: string; code: string; decision: string; operation_digest: string; challenge_id: string | null; grant_id: string | null }> {
    return this.database.query<
      { id: string; code: string; decision: string; operation_digest: string; challenge_id: string | null; grant_id: string | null },
      []
    >("SELECT id, code, decision, operation_digest, challenge_id, grant_id FROM owner_trust_decisions ORDER BY created_at").all();
  }
}
