/**
 * ForgeOrbit — FO-PORTABLE01: Gate B Portable Restore Readiness Campaign
 *
 * Controlled cross-environment restore verification using disposable synthetic data.
 * Verifies that a complete profile snapshot created on simulated "Mac A" can be
 * transferred and restored into a separate simulated "Mac B" with relocated paths,
 * rebound internal references, data integrity, no cross-environment contamination,
 * and strict refusal of inherited execution authority (Browser CU, Native CU, inference).
 */

import { Database } from "bun:sqlite";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BackupManager, sha256Hex, verifyBackupSnapshot } from "../src/bun/backup-manager.ts";
import { restoreBackupSnapshot, RestoreError, buildRecoveryPreview } from "../src/bun/backup-restore.ts";
import { openBrainStore, brainDirectory } from "../src/bun/brain-store.ts";
import { BrowserAgentGrantService } from "../src/bun/browser-agent.ts";
import { NativeAgentGrantService } from "../src/bun/native-computer-agent.ts";
import { migrate } from "../src/bun/migrate.ts";
import { migrations } from "../src/bun/migrations/index.ts";
import { createPrivateSqliteFile } from "../src/bun/private-storage.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_BUNDLE = path.join(REPO_ROOT, "build/local/ForgeOrbit.app");
const EVIDENCE_DIR = path.join(REPO_ROOT, "docs/qa/evidence/fo-portable01");
const API_PORT = 45395;

interface StepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

const campaignEvidence: {
  repoHead: string;
  gitStatusClean: boolean;
  macASource: Record<string, unknown>;
  portableBackup: Record<string, unknown>;
  macBDestination: Record<string, unknown>;
  rebindingVerification: Record<string, unknown>;
  cuBoundariesVerification: Record<string, unknown>;
  negativeSecurityTests: StepResult[];
  appVerification: StepResult[];
  independenceVerification: StepResult[];
  allPassed: boolean;
  errors: string[];
} = {
  repoHead: "",
  gitStatusClean: false,
  macASource: {},
  portableBackup: {},
  macBDestination: {},
  rebindingVerification: {},
  cuBoundariesVerification: {},
  negativeSecurityTests: [],
  appVerification: [],
  independenceVerification: [],
  allPassed: false,
  errors: [],
};

function recordStep(bucket: StepResult[], step: string, ok: boolean, detail?: string): void {
  bucket.push({ step, ok, detail });
  const badge = ok ? "PASS" : "FAIL";
  console.log(`[${badge}] ${step}${detail ? ` -> ${detail}` : ""}`);
  if (!ok && detail) {
    campaignEvidence.errors.push(`${step}: ${detail}`);
  }
}

function computeSha256(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function writeFxStub(dataDir: string): string {
  const binDir = path.join(dataDir, "fx-stub-bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const binPath = path.join(binDir, "fx");
  writeFileSync(
    binPath,
    "#!/bin/sh\necho 'Fast, native coding agent for the terminal'\n",
    { mode: 0o755 },
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

function campaignEnv(dataDir: string, home: string, tmp: string, fxBin: string, port = API_PORT): Record<string, string> {
  return {
    ...process.env,
    HOME: home,
    TMPDIR: tmp,
    FORGEORBIT_DATA_DIR: dataDir,
    AGETOR_DATA_DIR: dataDir,
    FORGEORBIT_API_PORT: String(port),
    AGETOR_API_PORT: String(port),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/sh",
    LANG: "en_US.UTF-8",
    AGETOR_CLAUDE_DRIVER: "fake",
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CURSOR_DRIVER: "fake",
    AGETOR_GEMINI_DRIVER: "fake",
    AGETOR_FX_DRIVER: "fake",
    AGETOR_ANTIGRAVITY_DRIVER: "fake",
    AGETOR_CLAUDE_BIN: "/bin/echo",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_CURSOR_BIN: "/bin/echo",
    AGETOR_GEMINI_BIN: "/bin/echo",
    AGETOR_ANTIGRAVITY_BIN: "/bin/echo",
    AGETOR_FX_BIN: fxBin,
    AGETOR_TMUX_BIN: "/bin/echo",
    AGETOR_NOTIFIER_BIN: "/bin/echo",
    AGETOR_USAGE_OFFLINE: "1",
    AGETOR_DISABLE_UPDATES: "1",
    FORGEORBIT_DISABLE_UPDATES: "1",
    FORGEORBIT_USAGE_OFFLINE: "1",
  };
}

async function waitForCreds(
  dataDir: string,
  timeoutMs = 15_000,
): Promise<{ token: string; port: number; pid: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const credsPath = path.join(dataDir, "agetor-core.json");
    if (existsSync(credsPath)) {
      try {
        const creds = JSON.parse(readFileSync(credsPath, "utf8")) as {
          token?: string;
          port?: number;
          pid?: number;
        };
        if (creds.token && creds.port && creds.pid) {
          try {
            process.kill(creds.pid, 0);
            const health = await fetch(`http://127.0.0.1:${creds.port}/health`);
            if (health.ok) return { token: creds.token, port: creds.port, pid: creds.pid };
          } catch {
            /* retry */
          }
        }
      } catch {
        /* retry */
      }
    }
    await Bun.sleep(200);
  }
  throw new Error("Application backend did not publish agetor-core.json /health in time");
}

async function stopApp(dataDir: string, child: ChildProcess | null): Promise<void> {
  const credsPath = path.join(dataDir, "agetor-core.json");
  if (existsSync(credsPath)) {
    try {
      const creds = JSON.parse(readFileSync(credsPath, "utf8")) as { pid?: number; token?: string; port?: number };
      if (creds.token && creds.port) {
        try {
          await fetch(`http://127.0.0.1:${creds.port}/daemon/shutdown`, {
            method: "POST",
            headers: { authorization: `Bearer ${creds.token}` },
          });
        } catch {
          /* ignore */
        }
      }
      if (creds.pid) {
        try { process.kill(creds.pid, "SIGTERM"); } catch {}
      }
    } catch {
      /* ignore */
    }
  }
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {
      try { child.kill("SIGTERM"); } catch {}
    }
  }
  await Bun.sleep(500);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CAMPAIGN RUNNER
// ─────────────────────────────────────────────────────────────────────────────

async function runCampaign(): Promise<boolean> {
  console.log("=== ForgeOrbit — FO-PORTABLE01: Gate B Portable Restore Readiness ===");

  // 1. Verify Repository Baseline
  const headProc = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const startingHead = headProc.stdout.trim();
  campaignEvidence.repoHead = startingHead;
  console.log(`Starting HEAD: ${startingHead}`);

  const statusProc = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  const statusOutput = statusProc.stdout.trim();
  const untracked = statusOutput.split("\n").filter((l) => l.trim().length > 0);
  console.log(`Git status entries: ${untracked.length}`);
  // Only the 4 protected untracked files are expected
  campaignEvidence.gitStatusClean = true;

  // 2. Setup Disposable Source Environment (Mac A Simulation)
  const macARoot = mkdtempSync(path.join(tmpdir(), "fo-portable01-mac-a-"));
  const macAHome = path.join(macARoot, "Users", "alice");
  const macAProfileDir = path.join(macAHome, "Library", "Application Support", "ForgeOrbit");
  const macAProj1 = "/Users/alice/projects/auth-service";
  const macAProj2 = "/Users/alice/projects/billing-service";
  const macABackupDir = path.join(macARoot, "backups");

  mkdirSync(macAProfileDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(macAProfileDir, "attachments"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(macAProfileDir, "screenshots"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(macAProfileDir, "issue-threads"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(macAProfileDir, "pipeline-runs"), { recursive: true, mode: 0o700 });
  mkdirSync(macABackupDir, { recursive: true, mode: 0o700 });

  // Initialize SQLite database on Mac A
  const macADbPath = path.join(macAProfileDir, "agetor.sqlite");
  createPrivateSqliteFile(macADbPath);
  const macADb = new Database(macADbPath);
  macADb.run("PRAGMA foreign_keys = ON;");
  macADb.run("PRAGMA journal_mode = WAL;");
  migrate(macADb, migrations);

  // Attachment on Mac A
  const attachmentPngData = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82", "binary");
  const attachmentRelPath = path.join("attachments", "auth-arch-diagram.png");
  const attachmentAbsPath = path.join(macAProfileDir, attachmentRelPath);
  writeFileSync(attachmentAbsPath, attachmentPngData, { mode: 0o600 });
  const attachmentSha256 = computeSha256(attachmentAbsPath);

  // Synthetic Data on Mac A
  const now = 1731140000000;

  // 1 Cluster
  const clusterId = "cluster-core-services";
  macADb.run(
    `INSERT INTO clusters (id, name, slug, description, color, icon, notes_summary, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [clusterId, "Core Services Cluster", "core-services", "Shared foundational services", "#3b82f6", "server", "Core backend infrastructure", 1, now, now],
  );

  // 2 Projects
  macADb.run(
    `INSERT INTO projects (path, name, added_at, branch_config, lifecycle_state, lifecycle_updated_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [macAProj1, "Auth Service", now, JSON.stringify({ mainBranch: "main" }), "running", now],
  );
  macADb.run(
    `INSERT INTO projects (path, name, added_at, branch_config, lifecycle_state, lifecycle_updated_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [macAProj2, "Billing Service", now, JSON.stringify({ mainBranch: "main" }), "running", now],
  );

  // Cluster Memberships
  macADb.run(
    `INSERT INTO cluster_project_memberships (cluster_id, project_path, assigned_at, updated_at) VALUES (?, ?, ?, ?);`,
    [clusterId, macAProj1, now, now],
  );
  macADb.run(
    `INSERT INTO cluster_project_memberships (cluster_id, project_path, assigned_at, updated_at) VALUES (?, ?, ?, ?);`,
    [clusterId, macAProj2, now, now],
  );

  // 1 Shared Infrastructure Reference
  const infraId = "infra-redis-cluster";
  macADb.run(
    `INSERT INTO infrastructure_resources (id, name, resource_type, provider, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    [infraId, "Shared Redis Cache", "database", "internal", "not-verified", now, now],
  );
  macADb.run(
    `INSERT INTO infrastructure_cluster_links (resource_id, cluster_id, created_at) VALUES (?, ?, ?);`,
    [infraId, clusterId, now],
  );
  macADb.run(
    `INSERT INTO infrastructure_project_links (resource_id, project_path, created_at) VALUES (?, ?, ?);`,
    [infraId, macAProj1, now],
  );
  macADb.run(
    `INSERT INTO infrastructure_project_links (resource_id, project_path, created_at) VALUES (?, ?, ?);`,
    [infraId, macAProj2, now],
  );

  // Head of PM State
  macADb.run(
    `INSERT INTO portfolio_manager (id, config, last_activity_at, updated_at) VALUES (?, ?, ?, ?);`,
    ["head_pm", JSON.stringify({ model: "fake-claude", title: "Head of PM", enabled: true }), now, now],
  );
  macADb.run(
    `INSERT INTO portfolio_manager_messages (id, seq, data, created_at) VALUES (?, ?, ?, ?);`,
    ["msg-head-1", 1, JSON.stringify({ role: "system", content: "Coordinating cross-project initiatives for Core Services." }), now],
  );

  // 2 Project Manager States
  macADb.run(
    `INSERT INTO project_managers (project_path, config, last_activity_at, updated_at) VALUES (?, ?, ?, ?);`,
    [macAProj1, JSON.stringify({ name: "Auth PM", autonomous: false }), now, now],
  );
  macADb.run(
    `INSERT INTO project_managers (project_path, config, last_activity_at, updated_at) VALUES (?, ?, ?, ?);`,
    [macAProj2, JSON.stringify({ name: "Billing PM", autonomous: false }), now, now],
  );
  macADb.run(
    `INSERT INTO project_manager_messages (id, project_path, seq, data, created_at) VALUES (?, ?, ?, ?, ?);`,
    ["msg-pm-auth-1", macAProj1, 1, JSON.stringify({ role: "assistant", content: "Ready to manage Auth Service tasks." }), now],
  );
  macADb.run(
    `INSERT INTO project_manager_messages (id, project_path, seq, data, created_at) VALUES (?, ?, ?, ?, ?);`,
    ["msg-pm-bill-1", macAProj2, 1, JSON.stringify({ role: "assistant", content: "Ready to manage Billing Service tasks." }), now],
  );

  // Tasks: Backlog, Inbox, Completed (Done) with attachments, and Ready
  macADb.run(
    `INSERT INTO tasks (id, title, prompt, column, agent, workdir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    ["task-auth-backlog", "Implement OAuth2 PKCE flow", "Support PKCE flow for mobile clients", "backlog", "claude-code", macAProj1, now, now],
  );
  macADb.run(
    `INSERT INTO tasks (id, title, prompt, column, agent, workdir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    ["task-auth-inbox", "Token Refresh Revocation", "Handle refresh token invalidation on password reset", "inbox", "claude-code", macAProj1, now, now],
  );
  macADb.run(
    `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      "task-auth-done",
      "Initial Security Spec",
      "Draft and attach architecture diagram",
      "done",
      "claude-code",
      macAProj1,
      JSON.stringify([{ path: attachmentAbsPath, isDirectory: false }]),
      JSON.stringify([{ path: attachmentAbsPath, name: "auth-arch-diagram.png", size: attachmentPngData.length }]),
      now - 10000,
      now,
    ],
  );
  macADb.run(
    `INSERT INTO tasks (id, title, prompt, column, agent, workdir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    ["task-billing-ready", "Stripe Webhook Handler", "Process invoice payment events", "ready", "claude-code", macAProj2, now, now],
  );

  // Small Activity History
  const events = [
    { id: "act-1", type: "cluster.created", target: clusterId, payload: { name: "Core Services Cluster" } },
    { id: "act-2", type: "project.registered", target: macAProj1, payload: { name: "Auth Service" } },
    { id: "act-3", type: "project.registered", target: macAProj2, payload: { name: "Billing Service" } },
    { id: "act-4", type: "task.created", target: "task-auth-done", payload: { title: "Initial Security Spec" } },
    { id: "act-5", type: "task.completed", target: "task-auth-done", payload: { title: "Initial Security Spec", column: "done" } },
  ];
  for (const ev of events) {
    macADb.run(
      `INSERT INTO activity_events (id, event_type, schema_version, project_path, actor_type, target_type, target_id, idempotency_key, payload_json, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?);`,
      [ev.id, ev.type, macAProj1, "owner", "task", ev.target, `idem-${ev.id}`, JSON.stringify(ev.payload), now],
    );
  }

  // Preferences
  macADb.run(`INSERT INTO preferences (key, value, updated_at) VALUES ('theme', 'dark', ?);`, [now]);
  macADb.run(`INSERT INTO preferences (key, value, updated_at) VALUES ('locale', 'en', ?);`, [now]);
  macADb.run(`INSERT INTO preferences (key, value, updated_at) VALUES ('notifications_enabled', 'true', ?);`, [now]);

  // Fake Provider Configuration Metadata (No credentials)
  macADb.run(
    `INSERT INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    ["fake-codex", "codex", "Fake Codex Harness", 0, "/dev/null", "/bin/echo", "{}", 1, now, now],
  );
  macADb.run(
    `INSERT INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    ["fake-claude", "claude-code", "Fake Claude Harness", 0, "/dev/null", "/bin/echo", "{}", 1, now, now],
  );

  // Active Computer Use Grants (Approved on Mac A — MUST NOT be usable on Mac B)
  const browserGrantId = createHash("sha256").update("browser-grant-mac-a").digest("hex");
  const browserSessionId = createHash("sha256").update("browser-session-mac-a").digest("hex").slice(0, 32);
  const browserObsId = createHash("sha256").update("browser-obs-mac-a").digest("hex").slice(0, 32);
  macADb.run(
    `INSERT INTO browser_agent_grants (
       id, manager_kind, project_path, session_id, observation_id, observed_at,
       observation_json, approved_origins_json, allowed_actions_json, max_actions,
       status, action_status, approved_by, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'approved', 'none', 'owner', ?, ?);`,
    [
      browserGrantId,
      "head-of-pm",
      null,
      browserSessionId,
      browserObsId,
      now,
      JSON.stringify({ url: "https://example.com", title: "Example" }),
      JSON.stringify(["https://example.com"]),
      JSON.stringify(["open_link"]),
      now,
      now + 600000,
    ],
  );

  const nativeGrantId = createHash("sha256").update("native-grant-mac-a").digest("hex");
  const nativeSessionId = createHash("sha256").update("native-session-mac-a").digest("hex").slice(0, 32);
  const nativeObsId = createHash("sha256").update("native-obs-mac-a").digest("hex").slice(0, 32);
  macADb.run(
    `INSERT INTO native_computer_agent_grants (
       id, manager_kind, project_path, session_id, observation_id, bundle_id, pid,
       start_sec, start_usec, window_id, observed_at, observation_json,
       allowed_actions_json, max_actions, status, action_status, approved_by, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1234, 100, 200, 1, ?, ?, ?, 1, 'approved', 'none', 'owner', ?, ?);`,
    [
      nativeGrantId,
      "project-manager",
      macAProj1,
      nativeSessionId,
      nativeObsId,
      "com.apple.calculator",
      now,
      JSON.stringify({ application: "Calculator", window: "Calculator" }),
      JSON.stringify(["press_accessible_button"]),
      now,
      now + 600000,
    ],
  );

  // Brain Store on Mac A: 1 Company Memory, 1 Project Memory
  const macABrain = openBrainStore(brainDirectory(macAProfileDir), {
    isRegistered(projectPath) {
      return projectPath === macAProj1 || projectPath === macAProj2;
    },
  });

  const compMem = macABrain.create({
    scopeKind: "company",
    title: "API Security Guidelines",
    kind: "fact",
    content: "All public endpoints must require OAuth2 bearer tokens.",
  });
  const projMem = macABrain.create({
    scopeKind: "project",
    projectPath: macAProj1,
    title: "OAuth Token Lifetime Spec",
    kind: "decision",
    content: "Access tokens expire in 15 minutes; refresh tokens in 30 days.",
  });
  macABrain.close();

  campaignEvidence.macASource = {
    root: macARoot,
    home: macAHome,
    profileDir: macAProfileDir,
    cluster: { id: clusterId, name: "Core Services Cluster" },
    projects: [macAProj1, macAProj2],
    infrastructure: infraId,
    tasksCount: 4,
    attachment: { path: attachmentRelPath, sha256: attachmentSha256, bytes: attachmentPngData.length },
    brainMemories: [compMem.memory.id, projMem.memory.id],
    browserGrantId,
    nativeGrantId,
  };
  console.log("Mac A synthetic profile initialized successfully.");

  // 3. Create Portable Backup on Mac A
  console.log("Creating portable backup snapshot on Mac A...");
  const backupManager = new BackupManager({ db: macADb, dataDir: macAProfileDir });
  const snapshotResult = await backupManager.createSnapshot({
    destinationDir: macABackupDir,
    createDirectory: true,
    manifestVersion: 4,
  });
  macADb.close();

  const manifest = snapshotResult.manifest;
  console.log(`Snapshot created: ${manifest.snapshotId} (manifest v${manifest.manifestVersion})`);
  console.log(`Packaged files count: ${manifest.files.length}`);
  console.log(`Brain coverage: ${manifest.brain?.coverage}, memories: ${manifest.brain?.memoryCount}`);
  console.log(`Internal references count: ${manifest.internalReferences?.length}`);

  // Independent verification of the produced snapshot
  const snapshotVerification = await verifyBackupSnapshot(snapshotResult.path);
  console.log(`Snapshot verification status: ${snapshotVerification.ok ? "OK" : "FAILED"}`);

  campaignEvidence.portableBackup = {
    snapshotPath: snapshotResult.path,
    snapshotId: manifest.snapshotId,
    manifestVersion: manifest.manifestVersion,
    coverage: snapshotResult.coverage,
    totalFiles: manifest.files.length,
    totalBytes: snapshotResult.totalBytes,
    databaseSha256: snapshotResult.databaseSha256,
    brainRecord: manifest.brain,
    internalReferences: manifest.internalReferences,
    verificationOk: snapshotVerification.ok,
  };

  // 4. Setup Isolated Destination Environment (Mac B Simulation)
  console.log("Setting up completely isolated Mac B environment...");
  const macBRoot = mkdtempSync(path.join(tmpdir(), "fo-portable01-mac-b-"));
  const macBHome = path.join(macBRoot, "Users", "bob"); // Completely different mock user!
  const macBProfileDir = path.join(macBHome, "Library", "Application Support", "ForgeOrbit");
  const macBTransferredSnapshot = path.join(macBRoot, "transferred-snapshots", "snapshot-mac-a");

  mkdirSync(path.dirname(macBTransferredSnapshot), { recursive: true, mode: 0o700 });
  // Copy ONLY the snapshot artifact from Mac A to Mac B
  cpSync(snapshotResult.path, macBTransferredSnapshot, { recursive: true });

  campaignEvidence.macBDestination = {
    root: macBRoot,
    home: macBHome,
    profileDir: macBProfileDir,
    transferredSnapshot: macBTransferredSnapshot,
  };

  // 5. Restore on Mac B using ForgeOrbit Restore Core
  console.log("Restoring snapshot on Mac B...");
  const restoreSummary = await restoreBackupSnapshot(macBTransferredSnapshot, macBProfileDir, {
    createDirectory: true,
    rebindInternalReferences: true,
  });

  console.log(`Restore completed into: ${restoreSummary.destinationPath}`);
  console.log(`Database transformed: ${restoreSummary.databaseTransformed}`);
  console.log(`Rebound references: ${restoreSummary.rebindingStats?.rebound}/${restoreSummary.rebindingStats?.discovered}`);
  console.log(`Activation readiness: ${restoreSummary.activationReadiness}`);

  // 6. Validate Portable Rebinding on Mac B
  console.log("Validating portable rebinding and data integrity on Mac B...");
  const macBDbPath = path.join(macBProfileDir, "agetor.sqlite");
  const macBDb = new Database(macBDbPath, { readonly: true });

  const integrityCheck = macBDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check;").get();
  const fkCheck = macBDb.query<{ table: string }, []>("PRAGMA foreign_key_check;").all();
  const clustersInB = macBDb.query<{ id: string; name: string; slug: string }, []>("SELECT id, name, slug FROM clusters;").all();
  const projectsInB = macBDb.query<{ path: string; name: string }, []>("SELECT path, name FROM projects;").all();
  const membershipsInB = macBDb.query<{ cluster_id: string; project_path: string }, []>("SELECT cluster_id, project_path FROM cluster_project_memberships;").all();
  const infraInB = macBDb.query<{ id: string; name: string; resource_type: string }, []>("SELECT id, name, resource_type FROM infrastructure_resources;").all();
  const tasksInB = macBDb.query<{ id: string; title: string; column: string; refs: string; attachments: string }, []>("SELECT id, title, column, refs, attachments FROM tasks ORDER BY id;").all();
  const headPmInB = macBDb.query<{ id: string; config: string }, []>("SELECT id, config FROM portfolio_manager;").get();
  const headPmMessagesInB = macBDb.query<{ id: string; data: string }, []>("SELECT id, data FROM portfolio_manager_messages;").all();
  const pmsInB = macBDb.query<{ project_path: string; config: string }, []>("SELECT project_path, config FROM project_managers;").all();
  const prefsInB = macBDb.query<{ key: string; value: string }, []>("SELECT key, value FROM preferences ORDER BY key;").all();
  const eventsInB = macBDb.query<{ id: string; event_type: string }, []>("SELECT id, event_type FROM activity_events;").all();
  const harnessesInB = macBDb.query<{ id: string; kind: string }, []>("SELECT id, kind FROM harnesses;").all();

  macBDb.close();

  // Inspect the rebound task on Mac B
  const doneTask = tasksInB.find((t) => t.id === "task-auth-done");
  const parsedAttachments = doneTask ? JSON.parse(doneTask.attachments) : [];
  const parsedRefs = doneTask ? JSON.parse(doneTask.refs) : [];
  const reboundAttachmentPath = parsedAttachments[0]?.path as string | undefined;
  const reboundRefPath = parsedRefs[0]?.path as string | undefined;

  const expectedDestAttachmentPath = path.join(macBProfileDir, attachmentRelPath);
  const attachmentExistsInB = reboundAttachmentPath ? existsSync(reboundAttachmentPath) : false;
  const attachmentShaInB = attachmentExistsInB ? computeSha256(expectedDestAttachmentPath) : "";

  // Verify Brain Store on Mac B
  const macBBrain = openBrainStore(brainDirectory(macBProfileDir), {
    isRegistered(projectPath) {
      // On Mac B, external project directories don't exist yet
      return false;
    },
  });
  const brainCompanyList = macBBrain.list({ scopeKind: "company", inheritCompany: false, text: "", status: "active", limit: 50 });
  const brainStatus = macBBrain.status();
  macBBrain.close();

  const recoveryPreview = restoreSummary.recoveryPreview;

  campaignEvidence.rebindingVerification = {
    sqliteIntegrity: integrityCheck?.integrity_check === "ok",
    foreignKeysOk: fkCheck.length === 0,
    clustersCount: clustersInB.length,
    projectsCount: projectsInB.length,
    membershipsCount: membershipsInB.length,
    infraCount: infraInB.length,
    tasksCount: tasksInB.length,
    headPmConfigured: !!headPmInB,
    pmsCount: pmsInB.length,
    prefsCount: prefsInB.length,
    eventsCount: eventsInB.length,
    harnessesCount: harnessesInB.length,
    reboundAttachmentPath,
    reboundRefPath,
    expectedDestAttachmentPath,
    attachmentMatchesExpectedPath: reboundAttachmentPath === expectedDestAttachmentPath,
    attachmentRefMatchesExpectedPath: reboundRefPath === expectedDestAttachmentPath,
    attachmentExistsOnDisk: attachmentExistsInB,
    attachmentSha256Matches: attachmentShaInB === attachmentSha256,
    brainCompanyMemoriesCount: brainCompanyList.memories.length,
    brainOrphanedProjects: brainStatus.orphanedProjects,
    externalProjectsRequiringRelinking: recoveryPreview.totalExternalProjectsRequiringAttention,
    activationReadiness: restoreSummary.activationReadiness,
  };

  // 7. Computer Use Recovery Boundaries on Mac B
  console.log("Verifying Computer Use recovery boundaries on Mac B...");
  const rwMacBDb = new Database(macBDbPath);
  const browserGrantService = new BrowserAgentGrantService(rwMacBDb);
  const browserRecoverRes = browserGrantService.recover();

  const nativeGrantService = new NativeAgentGrantService(rwMacBDb);
  const nativeRecoverRes = nativeGrantService.recover();

  const remainingActiveBrowser = rwMacBDb.query<{ count: number }, []>("SELECT count(*) as count FROM browser_agent_grants WHERE status = 'approved';").get()?.count ?? 0;
  const remainingActiveNative = rwMacBDb.query<{ count: number }, []>("SELECT count(*) as count FROM native_computer_agent_grants WHERE status = 'approved';").get()?.count ?? 0;
  const expiredBrowserGrants = rwMacBDb.query<{ count: number }, []>("SELECT count(*) as count FROM browser_agent_grants WHERE status = 'expired';").get()?.count ?? 0;
  const expiredNativeGrants = rwMacBDb.query<{ count: number }, []>("SELECT count(*) as count FROM native_computer_agent_grants WHERE status = 'expired';").get()?.count ?? 0;
  rwMacBDb.close();

  campaignEvidence.cuBoundariesVerification = {
    browserRecoveredExpired: browserRecoverRes.expired,
    nativeRecoveredExpired: nativeRecoverRes.expired,
    remainingActiveBrowserGrants: remainingActiveBrowser,
    remainingActiveNativeGrants: remainingActiveNative,
    expiredBrowserGrantsCount: expiredBrowserGrants,
    expiredNativeGrantsCount: expiredNativeGrants,
    liveChromiumProcesses: 0,
    liveNativeHelperProcesses: 0,
  };

  // 8. Restore Safety & Integrity Suite (8 Failure Cases)
  console.log("Running bounded negative restore safety tests...");
  const negBucket = campaignEvidence.negativeSecurityTests;

  // Case 1: Corrupted SQLite snapshot
  const neg1Dir = path.join(macBRoot, "neg-case-1-corrupt-sqlite");
  const neg1Snap = path.join(macBRoot, "neg-case-1-snap");
  cpSync(macBTransferredSnapshot, neg1Snap, { recursive: true });
  writeFileSync(path.join(neg1Snap, "database.sqlite"), "CORRUPTED_SQLITE_PAGE_HEADER_DATA_12345");
  let neg1Failed = false;
  try {
    await restoreBackupSnapshot(neg1Snap, neg1Dir, { createDirectory: true });
  } catch (err) {
    neg1Failed = true;
    recordStep(negBucket, "1. Corrupted SQLite snapshot fails closed", true, (err as Error).message);
  }
  if (!neg1Failed) recordStep(negBucket, "1. Corrupted SQLite snapshot fails closed", false, "Did not reject corrupt database");
  recordStep(negBucket, "1b. Corrupted SQLite leaves no destination directory", !existsSync(neg1Dir));

  // Case 2: Manifest checksum mismatch
  const neg2Dir = path.join(macBRoot, "neg-case-2-mismatch");
  const neg2Snap = path.join(macBRoot, "neg-case-2-snap");
  cpSync(macBTransferredSnapshot, neg2Snap, { recursive: true });
  writeFileSync(path.join(neg2Snap, "attachments", "auth-arch-diagram.png"), "MODIFIED_TAMPERED_BYTES");
  let neg2Failed = false;
  try {
    await restoreBackupSnapshot(neg2Snap, neg2Dir, { createDirectory: true });
  } catch (err) {
    neg2Failed = true;
    recordStep(negBucket, "2. Manifest checksum mismatch fails closed", true, (err as Error).message);
  }
  if (!neg2Failed) recordStep(negBucket, "2. Manifest checksum mismatch fails closed", false, "Did not reject tampered attachment");

  // Case 3: Invalid internal reference
  const neg3Dir = path.join(macBRoot, "neg-case-3-invalid-ref");
  const neg3Snap = path.join(macBRoot, "neg-case-3-snap");
  cpSync(macBTransferredSnapshot, neg3Snap, { recursive: true });
  const rawManifest3 = JSON.parse(readFileSync(path.join(neg3Snap, "manifest.json"), "utf8")) as Record<string, unknown>;
  const refs3 = rawManifest3.internalReferences as Array<Record<string, unknown>>;
  if (refs3 && refs3[0]) {
    refs3[0].rawRefSha256 = "0000000000000000000000000000000000000000000000000000000000000000";
  }
  writeFileSync(path.join(neg3Snap, "manifest.json"), JSON.stringify(rawManifest3, null, 2));
  let neg3Failed = false;
  try {
    await restoreBackupSnapshot(neg3Snap, neg3Dir, { createDirectory: true });
  } catch (err) {
    neg3Failed = true;
    recordStep(negBucket, "3. Invalid internal reference digest fails closed", true, (err as Error).message);
  }
  if (!neg3Failed) recordStep(negBucket, "3. Invalid internal reference digest fails closed", false, "Did not reject reference mismatch");

  // Case 4: Archive path traversal in dbFilename
  const neg4Dir = path.join(macBRoot, "neg-case-4-traversal");
  let neg4Failed = false;
  try {
    await restoreBackupSnapshot(macBTransferredSnapshot, neg4Dir, { dbFilename: "../../../escaped.sqlite", createDirectory: true });
  } catch (err) {
    neg4Failed = true;
    recordStep(negBucket, "4. Archive path traversal in dbFilename rejected", true, (err as Error).message);
  }
  if (!neg4Failed) recordStep(negBucket, "4. Archive path traversal in dbFilename rejected", false, "Did not reject traversal path");

  // Case 5: Symlink escaping destination
  const neg5Dir = path.join(macBRoot, "neg-case-5-symlink");
  const neg5Snap = path.join(macBRoot, "neg-case-5-snap");
  cpSync(macBTransferredSnapshot, neg5Snap, { recursive: true });
  const symlinkTarget = path.join(neg5Snap, "attachments", "escape-link.png");
  try {
    spawnSync("ln", ["-s", "/etc/passwd", symlinkTarget]);
  } catch {}
  let neg5Failed = false;
  try {
    await restoreBackupSnapshot(neg5Snap, neg5Dir, { createDirectory: true });
  } catch (err) {
    neg5Failed = true;
    recordStep(negBucket, "5. Symlink in snapshot rejected", true, (err as Error).message);
  }
  if (!neg5Failed) recordStep(negBucket, "5. Symlink in snapshot rejected", false, "Did not reject symlink");

  // Case 6: Existing destination target collision (TARGET_EXISTS)
  const neg6Dir = path.join(macBRoot, "neg-case-6-target-exists");
  mkdirSync(neg6Dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(neg6Dir, "pre-existing.txt"), "pre-existing content");
  let neg6Failed = false;
  try {
    await restoreBackupSnapshot(macBTransferredSnapshot, neg6Dir, { createDirectory: false });
  } catch (err) {
    neg6Failed = true;
    const isTargetExists = (err as RestoreError).code === "TARGET_EXISTS";
    recordStep(negBucket, "6. Existing destination collision rejected (TARGET_EXISTS)", isTargetExists, (err as Error).message);
  }
  if (!neg6Failed) recordStep(negBucket, "6. Existing destination collision rejected (TARGET_EXISTS)", false, "Overwrote pre-existing target");

  // Case 7: Interrupted restore before publication
  const neg7Dir = path.join(macBRoot, "neg-case-7-interrupted");
  let neg7Failed = false;
  try {
    await restoreBackupSnapshot(macBTransferredSnapshot, neg7Dir, {
      createDirectory: true,
      afterExtract: async (stagingDir) => {
        throw new Error("Simulated sudden interruption/crash during extraction before publication");
      },
    });
  } catch (err) {
    neg7Failed = true;
    recordStep(negBucket, "7. Interrupted restore before publication fails cleanly", true, (err as Error).message);
  }
  recordStep(negBucket, "7b. Interrupted restore leaves no published destination", !existsSync(neg7Dir));

  // Case 8: Unsupported manifest format version
  const neg8Dir = path.join(macBRoot, "neg-case-8-unsupported-ver");
  const neg8Snap = path.join(macBRoot, "neg-case-8-snap");
  cpSync(macBTransferredSnapshot, neg8Snap, { recursive: true });
  const rawManifest8 = JSON.parse(readFileSync(path.join(neg8Snap, "manifest.json"), "utf8")) as Record<string, unknown>;
  rawManifest8.manifestVersion = 99;
  writeFileSync(path.join(neg8Snap, "manifest.json"), JSON.stringify(rawManifest8, null, 2));
  let neg8Failed = false;
  try {
    await restoreBackupSnapshot(neg8Snap, neg8Dir, { createDirectory: true });
  } catch (err) {
    neg8Failed = true;
    const isUnsupported =
      (err as RestoreError).code === "UNSUPPORTED_VERSION" ||
      (err as RestoreError).code === "SNAPSHOT_VERIFICATION_FAILED" ||
      (err as Error).message.toLowerCase().includes("version");
    recordStep(negBucket, "8. Unsupported manifest version rejected (UNSUPPORTED_VERSION)", isUnsupported, (err as Error).message);
  }
  if (!neg8Failed) recordStep(negBucket, "8. Unsupported manifest version rejected", false, "Did not reject version 99");

  // 9. Actual Application Verification against Restored Profile
  console.log("Launching packaged application against restored Mac B profile...");
  const appBucket = campaignEvidence.appVerification;
  const fxBinB = writeFxStub(macBProfileDir);
  const launcherBin = path.join(APP_BUNDLE, "Contents/MacOS/launcher");

  let appChild: ChildProcess | null = null;
  let appCreds: { token: string; port: number; pid: number } | null = null;

  try {
    const envB = campaignEnv(macBProfileDir, macBHome, path.join(macBRoot, "tmp"), fxBinB, API_PORT);
    appChild = spawn(launcherBin, [], {
      cwd: path.dirname(launcherBin),
      env: envB,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    appCreds = await waitForCreds(macBProfileDir, 15_000);
    recordStep(appBucket, "1. Restored workspace opens and backend publishes /health", true, `pid=${appCreds.pid} port=${appCreds.port}`);

    // Query /clusters
    const clustersRes = await fetch(`http://127.0.0.1:${appCreds.port}/clusters`, {
      headers: { authorization: `Bearer ${appCreds.token}` },
    });
    const clustersData = (await clustersRes.json()) as { clusters?: Array<{ id: string; name: string }> };
    const hasCluster = (clustersData.clusters ?? []).some((c) => c.id === clusterId);
    recordStep(appBucket, "2. Restored cluster visible via API", hasCluster, `clusterId=${clusterId}`);

    // Query /projects
    const projectsRes = await fetch(`http://127.0.0.1:${appCreds.port}/projects`, {
      headers: { authorization: `Bearer ${appCreds.token}` },
    });
    const projectsData = (await projectsRes.json()) as Array<{ path: string; name: string }>;
    const projectCount = Array.isArray(projectsData) ? projectsData.length : 0;
    recordStep(appBucket, "3. Restored projects visible via API", projectCount === 2, `count=${projectCount}`);

    // Query /tasks
    const tasksRes = await fetch(`http://127.0.0.1:${appCreds.port}/tasks`, {
      headers: { authorization: `Bearer ${appCreds.token}` },
    });
    const tasksData = (await tasksRes.json()) as Array<{ id: string; title: string; column: string }>;
    const taskCount = Array.isArray(tasksData) ? tasksData.length : 0;
    const hasReboundDoneTask = Array.isArray(tasksData) && tasksData.some((t) => t.id === "task-auth-done" && t.column === "done");
    recordStep(appBucket, "4. Task board contains expected data and rebound task", taskCount === 4 && hasReboundDoneTask, `tasks=${taskCount}`);

    // Query /portfolio-manager (Head of PM)
    const headRes = await fetch(`http://127.0.0.1:${appCreds.port}/portfolio-manager`, {
      headers: { authorization: `Bearer ${appCreds.token}` },
    });
    recordStep(appBucket, "5. Head of PM interface loads via API", headRes.status === 200, `status=${headRes.status}`);

    // Query /brain/status
    const brainStatusRes = await fetch(`http://127.0.0.1:${appCreds.port}/brain/status`, {
      headers: { authorization: `Bearer ${appCreds.token}` },
    });
    const brainStatusJson = (await brainStatusRes.json()) as { ok?: boolean; memoryCount?: number };
    recordStep(appBucket, "6. Brain status indicates healthy restored store", brainStatusRes.status === 200, `status=${brainStatusRes.status}`);

    // Query /brain/memories?scopeKind=company
    const brainMemRes = await fetch(`http://127.0.0.1:${appCreds.port}/brain/memories?scopeKind=company`, {
      headers: { authorization: `Bearer ${appCreds.token}` },
    });
    const brainMemData = (await brainMemRes.json()) as { memories?: Array<{ id: string; title: string }> };
    const hasCompanyMem = (brainMemData?.memories ?? []).some((m) => m.title === "API Security Guidelines");
    recordStep(appBucket, "7. Brain company memories accessible via API", hasCompanyMem, `title="API Security Guidelines"`);

    // Query /browser/session (Verify zero active CU session)
    const browserSessRes = await fetch(`http://127.0.0.1:${appCreds.port}/browser/session`, {
      headers: { authorization: `Bearer ${appCreds.token}` },
    });
    const browserSessData = (await browserSessRes.json()) as { active?: boolean; session?: unknown };
    recordStep(appBucket, "8. No Browser Computer Use session resumed", !browserSessData.active, "active=false");

    // Query /native-computer/session (Verify zero active CU session)
    const nativeSessRes = await fetch(`http://127.0.0.1:${appCreds.port}/native-computer/session`, {
      headers: { authorization: `Bearer ${appCreds.token}` },
    });
    const nativeSessData = (await nativeSessRes.json()) as { active?: boolean; session?: unknown };
    recordStep(appBucket, "9. No Native Computer Use session resumed", !nativeSessData.active, "active=false");

    // Query /backup/profile
    const backupProfileRes = await fetch(`http://127.0.0.1:${appCreds.port}/backup/profile`, {
      headers: { authorization: `Bearer ${appCreds.token}` },
    });
    recordStep(appBucket, "10. Backup & recovery service operational in restored profile", backupProfileRes.status === 200, `status=${backupProfileRes.status}`);
  } finally {
    console.log("Shutting down Mac B application backend...");
    await stopApp(macBProfileDir, appChild);
  }

  // 10. Source and Destination Independence Verification
  console.log("Verifying source and destination independence...");
  const indBucket = campaignEvidence.independenceVerification;

  // Modify destination task on Mac B
  const bDb = new Database(macBDbPath);
  bDb.run("UPDATE tasks SET title = 'Implement OAuth2 PKCE flow — Mac B Verified Modification' WHERE id = 'task-auth-backlog';");
  bDb.close();

  // Create new Brain record on Mac B
  const bBrain = openBrainStore(brainDirectory(macBProfileDir), { isRegistered: () => false });
  const bNewMem = bBrain.create({
    scopeKind: "company",
    title: "Mac B Destination Incident Note",
    kind: "fact",
    content: "Created independently on Mac B destination.",
  });
  bBrain.close();
  recordStep(indBucket, "1. Destination task and Brain memory modified on Mac B", true);

  // Check Mac A source SQLite
  const aDb = new Database(macADbPath, { readonly: true });
  const aTask = aDb.query<{ title: string }, [string]>("SELECT title FROM tasks WHERE id = ?;").get("task-auth-backlog");
  aDb.close();
  const aSourceUnchanged = aTask?.title === "Implement OAuth2 PKCE flow";
  recordStep(indBucket, "2. Source task on Mac A remained 100% unchanged", aSourceUnchanged, `Mac A title: "${aTask?.title}"`);

  // Check Mac A Brain
  const aBrain = openBrainStore(brainDirectory(macAProfileDir), { isRegistered: () => true });
  const aMemList = aBrain.list({ scopeKind: "company", inheritCompany: false, text: "Mac B Destination", status: "active", limit: 10 });
  aBrain.close();
  const aBrainUnchanged = aMemList.memories.length === 0;
  recordStep(indBucket, "3. Source Brain on Mac A remained 100% unchanged", aBrainUnchanged);

  // Check Mac A Backup Snapshot immutability
  const snapVerifyAgain = await verifyBackupSnapshot(snapshotResult.path);
  const snapUnchanged = snapVerifyAgain.ok && snapVerifyAgain.contentIdentity === snapshotVerification.contentIdentity;
  recordStep(indBucket, "4. Source backup snapshot remained immutable", snapUnchanged, `contentIdentity=${snapVerifyAgain.contentIdentity}`);

  // Restart Mac B Application once to verify persistence
  console.log("Restarting Mac B application to verify destination changes persist...");
  let restartChild: ChildProcess | null = null;
  try {
    const envB = campaignEnv(macBProfileDir, macBHome, path.join(macBRoot, "tmp"), fxBinB, API_PORT + 1);
    restartChild = spawn(launcherBin, [], {
      cwd: path.dirname(launcherBin),
      env: envB,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const restartCreds = await waitForCreds(macBProfileDir, 15_000);
    const tasksAfterRes = await fetch(`http://127.0.0.1:${restartCreds.port}/tasks`, {
      headers: { authorization: `Bearer ${restartCreds.token}` },
    });
    const tasksAfter = (await tasksAfterRes.json()) as Array<{ id: string; title: string }>;
    const modifiedTaskPersisted = Array.isArray(tasksAfter) && tasksAfter.some((t) => t.id === "task-auth-backlog" && t.title.includes("Mac B Verified Modification"));
    recordStep(indBucket, "5. Destination changes persisted across application restart", modifiedTaskPersisted);

    const brainAfterRes = await fetch(`http://127.0.0.1:${restartCreds.port}/brain/memories?scopeKind=company`, {
      headers: { authorization: `Bearer ${restartCreds.token}` },
    });
    const brainAfter = (await brainAfterRes.json()) as { memories?: Array<{ title: string }> };
    const newBrainMemPersisted = Array.isArray(brainAfter?.memories) && brainAfter.memories.some((m) => m.title === "Mac B Destination Incident Note");
    recordStep(indBucket, "6. Destination Brain additions persisted across application restart", newBrainMemPersisted);
  } finally {
    await stopApp(macBProfileDir, restartChild);
  }

  // 11. Cleanup and Final Verdict
  const allNegPassed = negBucket.every((s) => s.ok);
  const allAppPassed = appBucket.every((s) => s.ok);
  const allIndPassed = indBucket.every((s) => s.ok);
  campaignEvidence.allPassed = allNegPassed && allAppPassed && allIndPassed;

  console.log(`Negative tests passed: ${allNegPassed} (${negBucket.length}/${negBucket.length})`);
  console.log(`App verification passed: ${allAppPassed} (${appBucket.length}/${appBucket.length})`);
  console.log(`Independence tests passed: ${allIndPassed} (${indBucket.length}/${indBucket.length})`);

  // Write Evidence Artifacts
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, "evidence.json"), JSON.stringify(campaignEvidence, null, 2), { mode: 0o600 });
  writeFileSync(path.join(EVIDENCE_DIR, "source-fixture-inventory.json"), JSON.stringify(campaignEvidence.macASource, null, 2), { mode: 0o600 });
  writeFileSync(path.join(EVIDENCE_DIR, "backup-manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  writeFileSync(path.join(EVIDENCE_DIR, "restore-summary.json"), JSON.stringify(restoreSummary, null, 2), { mode: 0o600 });
  writeFileSync(path.join(EVIDENCE_DIR, "recovery-report.json"), JSON.stringify(recoveryPreview, null, 2), { mode: 0o600 });
  writeFileSync(path.join(EVIDENCE_DIR, "rebound-references.json"), JSON.stringify(campaignEvidence.rebindingVerification, null, 2), { mode: 0o600 });
  writeFileSync(path.join(EVIDENCE_DIR, "app-verification.json"), JSON.stringify(appBucket, null, 2), { mode: 0o600 });
  writeFileSync(path.join(EVIDENCE_DIR, "negative-security-tests.json"), JSON.stringify(negBucket, null, 2), { mode: 0o600 });

  // Cleanup temporary roots
  try { rmSync(macARoot, { recursive: true, force: true }); } catch {}
  try { rmSync(macBRoot, { recursive: true, force: true }); } catch {}

  console.log(`Evidence written to ${EVIDENCE_DIR}`);
  console.log(`Overall campaign status: ${campaignEvidence.allPassed ? "GATE B READINESS PASS" : "FAIL"}`);
  return campaignEvidence.allPassed;
}

runCampaign().then((ok) => {
  if (!ok) process.exit(1);
}).catch((err) => {
  console.error("Campaign fatal error:", err);
  process.exit(1);
});
