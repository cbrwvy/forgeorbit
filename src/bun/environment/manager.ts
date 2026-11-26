/**
 * Lifecycle of local environments.
 *
 * One manager instance owns its slots. Two projects do not share a phase, a
 * lock, or a process handle. Start is single-flight per profile: a second
 * Start joins the in-flight operation instead of spawning again. Stop never
 * signals a pid (or a compose project) that a fresh probe cannot prove is ours.
 *
 * Recorded phase and the last observation are stored separately. After a
 * restart, call {@link EnvironmentManager.restore} — it reloads the repository
 * and probes. It does not trust a saved PID by itself and it does not stop
 * anything.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  composeStartDecision,
  FO_LABEL_TOKEN,
  type ComposeContainerSnapshot,
  type ComposeExpectation,
} from "../../shared/environment/compose-ownership.ts";
import { isLexicalInside } from "../../shared/environment/profile.ts";
import { composeServiceNames } from "../../shared/project-discovery.ts";
import { transitionRefusal, type TransitionContext } from "../../shared/environment/state.ts";
import { redactEnvironmentText } from "../../shared/environment/present.ts";
import type {
  ComposeOwnershipRecord,
  EnvironmentLogs,
  EnvironmentOperationResult,
  EnvironmentPhase,
  EnvironmentStatus,
  HealthOutcome,
  LaunchProfile,
  LogLine,
  ObservedRuntime,
  OwnershipClass,
  UrlAvailability,
} from "../../shared/environment/types.ts";
import { urlAvailability } from "../../shared/environment/urls.ts";
import { validateLaunchProfile } from "../../shared/environment/profile.ts";
import type { CommandRunner } from "./command-runner.ts";
import { createBunCommandRunner } from "./command-runner.ts";
import { createDockerComposeHost, type ComposeHost } from "./docker-compose.ts";
import { buildDockerEnv, buildProcessEnv } from "./env.ts";
import {
  composeProbe,
  createDefaultHealthProbes,
  expectationFor,
  runHealthChecks,
  type HealthProbes,
  type HealthRunResult,
} from "./health.ts";
import { LogBuffer } from "./logs.ts";
import {
  bunProcessSignaller,
  classifyProcessProbe,
  createBunProcessHost,
  createPsInspector,
  type ExitInfo,
  type LiveProcess,
  type LocalProcessHost,
  type ProcessInspector,
  type ProcessSignaller,
} from "./process-host.ts";
import { cancellableSleep } from "./sleep.ts";
import { MemoryEnvironmentStore, type EnvironmentRepository } from "./store.ts";

const LOG_BYTES = 64 * 1024;
const COMPOSE_TEXT_MAX = 1_000_000;

interface SlotLive extends LiveProcess {
  generation: number;
}

type SlotOwnership = import("../../shared/environment/types.ts").OwnershipRecord | null;

interface ConcreteSlot {
  profile: LaunchProfile;
  phase: EnvironmentPhase;
  ownership: SlotOwnership;
  ownershipClass: OwnershipClass;
  lastError: string | null;
  errorCode: import("../../shared/environment/types.ts").EnvErrorCode | null;
  updatedAt: number;
  sessionId: string | null;
  live: SlotLive | null;
  stopRequested: boolean;
  generation: number;
  lock: boolean;
  pending: Promise<EnvironmentOperationResult> | null;
  abort: AbortController | null;
  health: HealthOutcome[];
  logs: LogBuffer;
  observed: ObservedRuntime;
  /** Tokens minted for a launch before ownership is stored, so the first log line can be redacted. */
  extraSecrets: string[];
}

type AliveVerdict = "alive" | "dead" | "foreign" | "unverified" | "external";

/** Status and log notices for the existing app SSE channel. Log text is redacted. */
export interface EnvironmentNotice {
  projectPath: string;
  profileId: string;
  status: EnvironmentStatus;
  line?: LogLine;
}

export interface EnvironmentManagerOptions {
  store?: EnvironmentRepository;
  sessionId?: string;
  /** Fired after a persisted status change and after each log line. */
  listener?: (notice: EnvironmentNotice) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  processes?: LocalProcessHost;
  inspector?: ProcessInspector;
  signaller?: ProcessSignaller;
  compose?: ComposeHost;
  /** When set, replaces the built-in checker. Tests use this to avoid sockets. */
  health?: (profile: LaunchProfile, signal: AbortSignal) => Promise<HealthRunResult>;
  perlAvailable?: boolean;
  parentEnv?: Record<string, string | undefined>;
  markerDir?: string;
  dockerBin?: string;
  commandRunner?: CommandRunner;
}

export class EnvironmentManager {
  private readonly slots = new Map<string, ConcreteSlot>();
  private readonly store: EnvironmentRepository;
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly processes: LocalProcessHost;
  private readonly inspector: ProcessInspector;
  private readonly signaller: ProcessSignaller;
  private readonly compose: ComposeHost;
  private readonly healthOverride: EnvironmentManagerOptions["health"];
  private readonly parentEnv: Record<string, string | undefined>;
  private readonly markerDir: string;
  private readonly listener: ((notice: EnvironmentNotice) => void) | null;

  constructor(options: EnvironmentManagerOptions = {}) {
    this.sessionId = options.sessionId ?? randomBytes(8).toString("hex");
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? cancellableSleep;
    this.store = options.store ?? new MemoryEnvironmentStore();
    this.processes = options.processes ?? createBunProcessHost({ perlAvailable: options.perlAvailable, now: this.now });
    const runner = options.commandRunner ?? createBunCommandRunner();
    this.inspector =
      options.inspector ??
      createPsInspector({
        run: async (argv) => {
          const result = await runner.run(argv, { timeoutMs: 2_000, env: { ...buildDockerEnv(process.env), LC_ALL: "C" } });
          return { code: result.code, stdout: result.stdout };
        },
      });
    this.signaller = options.signaller ?? bunProcessSignaller;
    this.markerDir = options.markerDir ?? path.join(tmpdir(), "forgeorbit-env", this.sessionId);
    mkdirSync(this.markerDir, { recursive: true });
    this.compose =
      options.compose ??
      createDockerComposeHost({
        runner,
        dockerBin: options.dockerBin,
        markerDir: this.markerDir,
        parentEnv: options.parentEnv,
      });
    this.healthOverride = options.health;
    this.parentEnv = options.parentEnv ?? process.env;
    this.listener = options.listener ?? null;
  }

  async register(input: unknown): Promise<EnvironmentOperationResult> {
    const validated = validateLaunchProfile(input);
    if (!validated.ok) {
      return {
        ok: false,
        code: "invalid-profile",
        error: validated.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
        status: null,
      };
    }
    const profile = validated.profile;
    if (this.slots.has(profile.id)) {
      return { ok: false, code: "invalid-profile", error: `profile ${profile.id} already exists`, status: this.view(this.slots.get(profile.id)!) };
    }
    if (profile.launch.kind === "docker-compose") {
      for (const slot of this.slots.values()) {
        if (slot.profile.launch.kind === "docker-compose" && slot.profile.launch.projectName === profile.launch.projectName) {
          return {
            ok: false,
            code: "project-name-conflict",
            error: `compose project name ${profile.launch.projectName} is already used by ${slot.profile.id}`,
            status: null,
          };
        }
      }
    }
    const slot = this.makeSlot(profile);
    this.slots.set(profile.id, slot);
    await this.persist(slot);
    return { ok: true, status: this.view(slot) };
  }

  async unregister(id: string): Promise<EnvironmentOperationResult> {
    const slot = this.slots.get(id);
    if (!slot) return missing(id);
    const owned = slot.ownershipClass === "session" || slot.ownershipClass === "prior-forgeorbit";
    if (owned && slot.phase !== "stopped" && slot.phase !== "unknown") {
      const stopped = await this.stop(id);
      if (!stopped.ok && stopped.status?.recordedPhase !== "stopped") return stopped;
    }
    const status = this.view(slot);
    slot.abort?.abort();
    slot.logs.clear();
    this.slots.delete(id);
    await this.store.remove(id);
    return { ok: true, status };
  }

  /**
   * Replace a profile that is not running. A live owned process has to be
   * stopped first — editing it in place would change the command out from
   * under a pid we still have to prove.
   */
  async update(id: string, input: unknown): Promise<EnvironmentOperationResult> {
    const slot = this.slots.get(id);
    if (!slot) return missing(id);
    if (slot.lock || slot.phase === "starting" || slot.phase === "stopping") {
      return busy(slot, this.view(slot));
    }
    const owned = slot.ownershipClass === "session" || slot.ownershipClass === "prior-forgeorbit";
    if (slot.phase === "running" || slot.phase === "degraded" || (owned && slot.phase !== "stopped")) {
      return {
        ok: false,
        code: "busy",
        error: "stop the environment before changing its launch profile",
        status: this.view(slot),
      };
    }
    const validated = validateLaunchProfile(input);
    if (!validated.ok) {
      return {
        ok: false,
        code: "invalid-profile",
        error: validated.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
        status: this.view(slot),
      };
    }
    const profile = validated.profile;
    if (profile.id !== id) {
      return { ok: false, code: "invalid-profile", error: "profile id cannot change", status: this.view(slot) };
    }
    if (profile.projectPath !== slot.profile.projectPath) {
      return {
        ok: false,
        code: "invalid-profile",
        error: "profile cannot move to another project",
        status: this.view(slot),
      };
    }
    if (profile.launch.kind === "docker-compose") {
      for (const other of this.slots.values()) {
        if (other.profile.id === id) continue;
        if (
          other.profile.launch.kind === "docker-compose" &&
          other.profile.launch.projectName === profile.launch.projectName
        ) {
          return {
            ok: false,
            code: "project-name-conflict",
            error: `compose project name ${profile.launch.projectName} is already used by ${other.profile.id}`,
            status: this.view(slot),
          };
        }
      }
    }
    slot.profile = profile;
    slot.health = [];
    await this.persist(slot);
    return { ok: true, status: this.view(slot) };
  }

  profile(id: string): LaunchProfile | null {
    const slot = this.slots.get(id);
    return slot ? structuredClone(slot.profile) : null;
  }

  /** Re-probe one profile. Does not spawn and does not signal. */
  async refresh(id: string): Promise<EnvironmentOperationResult> {
    const slot = this.slots.get(id);
    if (!slot) return missing(id);
    if (slot.lock) return busy(slot, this.view(slot));
    await this.reconcileSlot(slot);
    return { ok: true, status: this.view(slot) };
  }

  /** Abort in-flight health checks and starts. Does not signal a process. */
  dispose(): void {
    for (const slot of this.slots.values()) slot.abort?.abort();
  }

  status(id: string): EnvironmentStatus | null {
    const slot = this.slots.get(id);
    return slot ? this.view(slot) : null;
  }

  list(): EnvironmentStatus[] {
    return [...this.slots.values()].map((slot) => this.view(slot));
  }

  urls(id: string): UrlAvailability[] | null {
    const slot = this.slots.get(id);
    if (!slot) return null;
    return urlAvailability(slot.profile.urls, slot.health);
  }

  async logs(id: string): Promise<EnvironmentLogs | null> {
    const slot = this.slots.get(id);
    if (!slot) return null;
    const lines = slot.logs.snapshot();
    if (
      slot.profile.launch.kind === "docker-compose" &&
      slot.ownership?.kind === "compose" &&
      (slot.ownershipClass === "session" || slot.ownershipClass === "prior-forgeorbit")
    ) {
      const expected = this.expectation(slot);
      if (expected) {
        const result = await this.compose.logs(expected, 200);
        if (result.ok && result.text.length > 0) {
          lines.push({ stream: "system", text: result.text, at: this.now() });
        }
      }
    }
    return {
      lines: lines.map((line) => ({ ...line, text: redactEnvironmentText(line.text, this.secrets(slot)) })),
    };
  }

  /**
   * Load whatever the repository remembered and probe it. Does not spawn and
   * does not signal. A PID that fails the ownership check becomes `unknown`.
   */
  async restore(): Promise<EnvironmentStatus[]> {
    const rows = await this.store.loadAll();
    for (const row of rows) {
      const validated = validateLaunchProfile(row.profile);
      if (!validated.ok || this.slots.has(validated.profile.id)) continue;
      const slot = this.makeSlot(validated.profile);
      slot.phase = row.runtime.phase;
      slot.ownership = row.runtime.ownership;
      slot.ownershipClass = row.runtime.ownershipClass;
      slot.lastError = row.runtime.lastError;
      slot.errorCode = row.runtime.errorCode;
      slot.sessionId = row.runtime.sessionId;
      slot.updatedAt = row.runtime.updatedAt;
      this.slots.set(slot.profile.id, slot);
    }
    return this.reconcile();
  }

  async reconcile(): Promise<EnvironmentStatus[]> {
    const statuses: EnvironmentStatus[] = [];
    for (const slot of this.slots.values()) {
      if (!slot.lock) await this.reconcileSlot(slot);
      statuses.push(this.view(slot));
    }
    return statuses;
  }

  start(id: string): Promise<EnvironmentOperationResult> {
    const slot = this.slots.get(id);
    if (!slot) return Promise.resolve(missing(id));
    if (slot.phase === "stopping") return Promise.resolve(busy(slot, this.view(slot)));
    if (slot.lock) return slot.pending ?? Promise.resolve(busy(slot, this.view(slot)));
    return this.occupy(slot, () => this.beginStart(slot));
  }

  stop(id: string): Promise<EnvironmentOperationResult> {
    const slot = this.slots.get(id);
    if (!slot) return Promise.resolve(missing(id));
    if (slot.phase === "stopped") return Promise.resolve({ ok: true, status: this.view(slot) });
    if (slot.phase === "starting" && slot.pending) {
      slot.stopRequested = true;
      slot.abort?.abort();
      // The aborted controller belonged to the health check. Shutdown has to
      // wait out its own grace period, so it gets a fresh controller.
      slot.abort = new AbortController();
      return slot.pending;
    }
    if (slot.lock) return slot.pending ?? Promise.resolve(busy(slot, this.view(slot)));
    return this.occupy(slot, () => this.beginStop(slot));
  }

  async restart(id: string): Promise<EnvironmentOperationResult> {
    const stopped = await this.stop(id);
    if (!stopped.ok) return stopped;
    if (stopped.status && stopped.status.recordedPhase !== "stopped") return stopped;
    return this.start(id);
  }

  private occupy(
    slot: ConcreteSlot,
    run: () => Promise<EnvironmentOperationResult>,
  ): Promise<EnvironmentOperationResult> {
    slot.lock = true;
    let resolvePending: (result: EnvironmentOperationResult) => void = () => {};
    const pending = new Promise<EnvironmentOperationResult>((resolve) => {
      resolvePending = resolve;
    });
    slot.pending = pending;
    const finish = (result: EnvironmentOperationResult): void => {
      // Drop the lock before resolving. A caller that awaits this promise and
      // then starts again (restart is stop-then-start) must not observe the
      // finished operation as still in flight and reuse its result.
      if (slot.pending === pending) {
        slot.pending = null;
        slot.lock = false;
      }
      resolvePending(result);
    };
    void run().then(finish, (error: unknown) => {
      finish({
        ok: false,
        code: "start-failed",
        error: error instanceof Error ? error.message : String(error),
        status: this.view(slot),
      });
    });
    return pending;
  }

  private async beginStart(slot: ConcreteSlot): Promise<EnvironmentOperationResult> {
    slot.stopRequested = false;
    slot.abort?.abort();
    slot.abort = new AbortController();

    if (slot.phase === "running" || slot.phase === "degraded" || (slot.phase === "unknown" && slot.ownership)) {
      const verdict = await this.confirmAlive(slot);
      if (verdict === "alive") return this.finishHealthy(slot, false);
      if (verdict === "foreign" || verdict === "external" || verdict === "unverified") {
        return this.refuseOwnership(slot, verdict);
      }
      this.assignPhase(slot, "stopped");
      slot.live = null;
      slot.ownership = null;
      slot.ownershipClass = "none";
    }

    if (slot.phase !== "starting") this.setPhase(slot, "starting");
    const preflight = this.preflight(slot.profile);
    if (preflight) return this.fail(slot, preflight.code, preflight.error);
    if (slot.stopRequested) return this.markStopped(slot);

    if (slot.profile.launch.kind === "local-process") return this.startLocal(slot);
    return this.startCompose(slot);
  }

  private async startLocal(slot: ConcreteSlot): Promise<EnvironmentOperationResult> {
    const profile = slot.profile;
    if (profile.launch.kind !== "local-process" || profile.stop.kind !== "signal") {
      return this.fail(slot, "invalid-profile", "local-process profile is missing its command or signal stop");
    }
    const token = randomBytes(16).toString("hex");
    slot.extraSecrets = [token];
    const env = buildProcessEnv({
      parent: this.parentEnv,
      bindings: profile.env,
      profileId: profile.id,
      token,
    });
    slot.generation += 1;
    const generation = slot.generation;
    const started = await this.processes.start({
      executable: profile.launch.command.executable,
      args: profile.launch.command.args,
      cwd: profile.cwd,
      env,
      processGroup: profile.stop.processGroup,
      token,
      onOutput: (stream, text) => {
        slot.logs.append(stream, redactEnvironmentText(text, this.secrets(slot)), this.now());
      },
    });
    if (!started.ok) return this.fail(slot, "start-failed", started.detail);
    const live: SlotLive = { ...started.process, generation };
    if (slot.stopRequested) {
      live.signal(profile.stop.signal);
      await this.raceExit(live.exited, profile.stop.graceMs, slot.abort?.signal);
      return this.markStopped(slot);
    }
    slot.live = live;
    slot.ownership = {
      kind: "process",
      pid: live.pid,
      startedAtMs: live.startedAtMs,
      token,
      sessionId: this.sessionId,
      executable: profile.launch.command.executable,
      args: [...profile.launch.command.args],
      cwd: profile.cwd,
      processGroup: live.processGroup,
    };
    slot.ownershipClass = "session";
    slot.sessionId = this.sessionId;
    slot.observed = { ownership: "session", processAlive: true, detail: null, at: this.now() };
    this.watchExit(slot, live);
    await this.persist(slot);
    if (slot.phase === "error" && slot.errorCode === "process-exited") {
      return { ok: false, code: "process-exited", error: slot.lastError ?? "process exited", status: this.view(slot) };
    }
    return this.applyStartupHealth(slot, true);
  }

  private async startCompose(slot: ConcreteSlot): Promise<EnvironmentOperationResult> {
    const profile = slot.profile;
    if (profile.launch.kind !== "docker-compose" || profile.stop.kind !== "compose-stop") {
      return this.fail(slot, "invalid-profile", "docker-compose profile is incomplete");
    }
    const available = await this.compose.availability();
    if (!available.ok) return this.fail(slot, "docker-unavailable", available.detail);
    if (slot.stopRequested) return this.markStopped(slot);

    const located = this.locateCompose(profile);
    if (!located.ok) return this.fail(slot, located.code, located.error);
    let text: string;
    try {
      const info = statSync(located.composeFile);
      if (info.size > COMPOSE_TEXT_MAX) return this.fail(slot, "start-failed", "compose file is too large to read");
      text = readFileSync(located.composeFile, "utf8");
    } catch (error) {
      return this.fail(slot, "missing-compose-file", error instanceof Error ? error.message : String(error));
    }
    const resolved = resolveServices(profile, text);
    if ("error" in resolved) return this.fail(slot, "start-failed", resolved.error);
    const services = resolved.services;

    const previous = slot.ownership?.kind === "compose" ? slot.ownership : null;
    const token = previous?.token ?? randomBytes(16).toString("hex");
    slot.extraSecrets = [token];
    const expected = expectationFor(
      profile.id,
      token,
      profile.launch.projectName,
      located.composeFile,
      located.cwd,
      previous?.containerIds ?? [],
      previous?.tokenApplied ?? false,
    );
    const view = await this.compose.inspect(expected);
    if (view.kind === "docker-error") return this.fail(slot, "start-failed", view.detail);
    const decision = composeStartDecision(view);
    if (decision === "refuse") {
      const code = view.kind === "external" ? "external-environment" : "foreign-compose-project";
      slot.ownership = null;
      slot.ownershipClass = view.kind === "external" ? "external" : "unverified";
      slot.lastError = "detail" in view ? view.detail : "compose project is not ours";
      slot.errorCode = code;
      slot.observed = { ownership: slot.ownershipClass, processAlive: null, detail: slot.lastError, at: this.now() };
      this.setPhase(slot, "unknown");
      await this.persist(slot);
      return { ok: false, code, error: slot.lastError, status: this.view(slot) };
    }
    if (decision === "already" && view.kind === "managed") {
      slot.ownership = composeRecord(profile, expected, view.containers, true);
      slot.ownershipClass = "session";
      slot.sessionId = this.sessionId;
      slot.observed = { ownership: "session", processAlive: null, detail: "compose project already running", at: this.now() };
      await this.persist(slot);
      return this.applyStartupHealth(slot, false);
    }

    const up = await this.compose.up(expected, services);
    if (!up.ok) return this.fail(slot, "start-failed", up.detail);
    if (slot.stopRequested) {
      slot.ownership = composeRecord(profile, expected, up.containers, labelsApplied(up.containers, token));
      slot.ownershipClass = "session";
      await this.shutdownCompose(slot);
      return this.markStopped(slot);
    }
    const applied = labelsApplied(up.containers, token);
    slot.ownership = composeRecord(profile, expected, up.containers, applied);
    slot.ownershipClass = "session";
    slot.sessionId = this.sessionId;
    slot.observed = { ownership: "session", processAlive: null, detail: null, at: this.now() };
    await this.persist(slot);
    return this.applyStartupHealth(slot, true);
  }

  private async applyStartupHealth(slot: ConcreteSlot, killOnFailure: boolean): Promise<EnvironmentOperationResult> {
    const raced = await this.raceHealth(slot);
    if (slot.stopRequested) {
      await this.shutdownCurrent(slot);
      return this.markStopped(slot);
    }
    if (slot.phase === "error" && slot.errorCode === "process-exited") {
      return { ok: false, code: "process-exited", error: slot.lastError ?? "process exited", status: this.view(slot) };
    }
    if (raced.type === "timeout") {
      if (killOnFailure) {
        slot.stopRequested = true;
        const outcome = await this.shutdownCurrent(slot);
        slot.stopRequested = false;
        if (outcome === "stopped") {
          slot.live = null;
          slot.ownership = null;
          slot.ownershipClass = "none";
        }
        return this.fail(slot, "startup-timeout", "startup timed out before health checks passed");
      }
      slot.lastError = "health check timed out";
      slot.errorCode = "startup-timeout";
      if (slot.phase === "starting") this.setPhase(slot, "degraded");
      else if (slot.phase === "running") this.setPhase(slot, "degraded");
      await this.persist(slot);
      return { ok: true, status: this.view(slot) };
    }
    const health = raced.result;
    slot.health = health.outcomes;
    if (!health.ok) {
      if (killOnFailure) {
        slot.stopRequested = true;
        const outcome = await this.shutdownCurrent(slot);
        slot.stopRequested = false;
        if (outcome === "stopped") {
          slot.live = null;
          slot.ownership = null;
          slot.ownershipClass = "none";
        }
      }
      const code = health.code === "cancelled" ? "cancelled" : health.code === "startup-timeout" ? "startup-timeout" : "health-failed";
      if (!killOnFailure) {
        slot.lastError = health.detail;
        slot.errorCode = code;
        if (slot.phase === "starting" || slot.phase === "running") this.setPhase(slot, "degraded");
        await this.persist(slot);
        return { ok: true, status: this.view(slot) };
      }
      return this.fail(slot, code, health.detail);
    }
    slot.lastError = null;
    slot.errorCode = null;
    const next = health.degraded ? "degraded" : "running";
    if (slot.phase !== next) this.setPhase(slot, next);
    await this.persist(slot);
    return { ok: true, status: this.view(slot) };
  }

  private async finishHealthy(slot: ConcreteSlot, killOnFailure: boolean): Promise<EnvironmentOperationResult> {
    slot.observed = {
      ownership: slot.ownershipClass,
      processAlive: slot.profile.launch.kind === "local-process" ? true : null,
      detail: "already running",
      at: this.now(),
    };
    return this.applyStartupHealth(slot, killOnFailure);
  }

  private async beginStop(slot: ConcreteSlot): Promise<EnvironmentOperationResult> {
    if (slot.ownershipClass === "external") {
      return {
        ok: false,
        code: "external-environment",
        error: slot.lastError ?? "environment was not started by ForgeOrbit",
        status: this.view(slot),
      };
    }
    slot.stopRequested = true;
    slot.abort?.abort();
    slot.abort = new AbortController();
    const verdict = await this.confirmAlive(slot);
    if (verdict === "dead") return this.markStopped(slot);
    if (verdict === "foreign" || verdict === "external" || verdict === "unverified") {
      return this.refuseOwnership(slot, verdict);
    }
    if (slot.phase !== "stopping") this.setPhase(slot, "stopping", { provenOwnership: true });
    const outcome = await this.shutdownCurrent(slot);
    if (outcome === "foreign") return this.refuseOwnership(slot, "foreign");
    if (outcome === "timeout") {
      return this.fail(slot, "shutdown-timeout", "shutdown timed out and the process is still alive");
    }
    return this.markStopped(slot);
  }

  private async shutdownCurrent(slot: ConcreteSlot): Promise<"stopped" | "timeout" | "foreign"> {
    if (slot.profile.launch.kind === "docker-compose") return this.shutdownCompose(slot);
    if (slot.profile.stop.kind !== "signal") return "stopped";
    return this.shutdownLocal(slot, slot.profile.stop);
  }

  private async shutdownLocal(
    slot: ConcreteSlot,
    stop: Extract<LaunchProfile["stop"], { kind: "signal" }>,
  ): Promise<"stopped" | "timeout" | "foreign"> {
    const ownership = slot.ownership?.kind === "process" ? slot.ownership : null;
    if (!slot.live && ownership) {
      const snapshot = await this.inspector.inspect(ownership.pid);
      const verdict = classifyProcessProbe(ownership, snapshot, this.sessionId);
      if (verdict.kind === "dead") return "stopped";
      if (verdict.kind !== "proven") return "foreign";
      this.signaller.signal(ownership.pid, stop.signal, ownership.processGroup);
      if (await this.waitUntilDead(ownership.pid, stop.graceMs)) return "stopped";
      if (stop.killAfterGrace) {
        const again = await this.inspector.inspect(ownership.pid);
        if (classifyProcessProbe(ownership, again, this.sessionId).kind !== "proven") return "foreign";
        this.signaller.signal(ownership.pid, "SIGKILL", ownership.processGroup);
        if (await this.waitUntilDead(ownership.pid, stop.graceMs)) return "stopped";
      }
      return "timeout";
    }
    if (!slot.live) return "stopped";
    slot.live.signal(stop.signal);
    if (await this.raceExit(slot.live.exited, stop.graceMs, slot.abort?.signal)) return "stopped";
    if (stop.killAfterGrace) {
      slot.live.signal("SIGKILL");
      if (await this.raceExit(slot.live.exited, stop.graceMs, slot.abort?.signal)) return "stopped";
    }
    return "timeout";
  }

  private async shutdownCompose(slot: ConcreteSlot): Promise<"stopped" | "timeout" | "foreign"> {
    const expected = this.expectation(slot);
    if (!expected) return "stopped";
    const profile = slot.profile;
    if (profile.launch.kind !== "docker-compose") return "stopped";
    const services = profile.launch.services;
    const stopped = await this.compose.stop(expected, services);
    if (!stopped.ok && stopped.refused) return "foreign";
    if (!stopped.ok) return "timeout";
    const after = await this.compose.inspect(expected);
    if (after.kind === "absent") return "stopped";
    if (after.kind === "managed" && !after.running) return "stopped";
    if (after.kind === "foreign" || after.kind === "external" || after.kind === "drift") return "foreign";
    if (after.kind === "docker-error") return "timeout";
    return "timeout";
  }

  private async confirmAlive(slot: ConcreteSlot): Promise<AliveVerdict> {
    if (slot.live) return "alive";
    if (!slot.ownership) return "dead";
    if (slot.ownership.kind === "process") {
      const snapshot = await this.inspector.inspect(slot.ownership.pid);
      const verdict = classifyProcessProbe(slot.ownership, snapshot, this.sessionId);
      if (verdict.kind === "proven") return "alive";
      if (verdict.kind === "dead") return "dead";
      if (verdict.kind === "foreign") return "foreign";
      return "unverified";
    }
    const expected = this.expectation(slot);
    if (!expected) return "dead";
    const view = await this.compose.inspect(expected);
    if (view.kind === "docker-error") return "unverified";
    if (view.kind === "absent") return "dead";
    if (view.kind === "managed") return view.running ? "alive" : "dead";
    if (view.kind === "external") return "external";
    return "foreign";
  }

  private async refuseOwnership(slot: ConcreteSlot, verdict: "foreign" | "external" | "unverified"): Promise<EnvironmentOperationResult> {
    const code = verdict === "foreign" ? "foreign-process" : verdict === "external" ? "external-environment" : "unverified-ownership";
    const error =
      verdict === "external"
        ? "environment is running but was not started by ForgeOrbit"
        : verdict === "foreign"
          ? "refusing to signal a process this environment does not own"
          : "refusing to signal a process whose ownership cannot be verified";
    slot.ownershipClass = verdict === "foreign" ? "external" : verdict === "external" ? "external" : "unverified";
    slot.lastError = error;
    slot.errorCode = code;
    slot.observed = { ownership: slot.ownershipClass, processAlive: true, detail: error, at: this.now() };
    if (slot.phase !== "unknown") this.setPhase(slot, "unknown");
    await this.persist(slot);
    return { ok: false, code, error, status: this.view(slot) };
  }

  private async reconcileSlot(slot: ConcreteSlot): Promise<void> {
    if (slot.profile.launch.kind === "local-process") {
      if (!slot.ownership || slot.ownership.kind !== "process") {
        if (
          slot.phase === "starting" ||
          slot.phase === "stopping" ||
          slot.phase === "running" ||
          slot.phase === "degraded"
        ) {
          const interrupted = slot.phase === "starting" || slot.phase === "stopping";
          slot.phase = "stopped";
          slot.lastError = interrupted
            ? "operation was interrupted by a restart"
            : "recorded running state had no ownership to re-check";
          slot.ownershipClass = "none";
          slot.ownership = null;
          slot.errorCode = null;
          slot.observed = { ownership: "none", processAlive: false, detail: slot.lastError, at: this.now() };
          await this.persist(slot);
        }
        return;
      }
      const snapshot = await this.inspector.inspect(slot.ownership.pid);
      const verdict = classifyProcessProbe(slot.ownership, snapshot, this.sessionId);
      if (verdict.kind === "dead") {
        slot.phase = "stopped";
        slot.ownership = null;
        slot.ownershipClass = "none";
        slot.lastError = "process was not running at recovery";
        slot.observed = { ownership: "none", processAlive: false, detail: slot.lastError, at: this.now() };
        await this.persist(slot);
        return;
      }
      if (verdict.kind !== "proven") {
        slot.phase = "unknown";
        slot.ownershipClass = verdict.kind === "foreign" ? "external" : "unverified";
        slot.lastError = verdict.detail;
        slot.errorCode = verdict.kind === "foreign" ? "foreign-process" : "unverified-ownership";
        slot.observed = { ownership: slot.ownershipClass, processAlive: true, detail: verdict.detail, at: this.now() };
        await this.persist(slot);
        return;
      }
      slot.ownershipClass = verdict.relation;
      slot.observed = { ownership: verdict.relation, processAlive: true, detail: null, at: this.now() };
      const health = await this.evaluateHealth(slot, new AbortController().signal);
      slot.health = health.outcomes;
      slot.phase = health.ok && !health.degraded ? "running" : "degraded";
      slot.lastError = health.ok ? null : health.detail;
      await this.persist(slot);
      return;
    }

    const expected = this.expectation(slot);
    if (!expected) {
      if (slot.phase === "starting" || slot.phase === "stopping") {
        slot.phase = "stopped";
        slot.lastError = "operation was interrupted by a restart";
        await this.persist(slot);
      }
      return;
    }
    const view = await this.compose.inspect(expected);
    if (view.kind === "absent" || (view.kind === "managed" && !view.running)) {
      slot.phase = "stopped";
      slot.ownership = null;
      slot.ownershipClass = "none";
      slot.observed = { ownership: "none", processAlive: null, detail: "compose project is not running", at: this.now() };
      await this.persist(slot);
      return;
    }
    if (view.kind === "managed") {
      slot.ownershipClass = slot.sessionId === this.sessionId ? "session" : "prior-forgeorbit";
      slot.observed = { ownership: slot.ownershipClass, processAlive: null, detail: null, at: this.now() };
      const health = await this.evaluateHealth(slot, new AbortController().signal);
      slot.health = health.outcomes;
      slot.phase = health.ok && !health.degraded ? "running" : "degraded";
      slot.lastError = health.ok ? null : health.detail;
      await this.persist(slot);
      return;
    }
    slot.phase = "unknown";
    slot.ownership = null;
    slot.ownershipClass = view.kind === "external" ? "external" : "unverified";
    slot.lastError = view.kind === "docker-error" ? view.detail : view.detail;
    slot.observed = { ownership: slot.ownershipClass, processAlive: null, detail: slot.lastError, at: this.now() };
    await this.persist(slot);
  }

  private async raceHealth(
    slot: ConcreteSlot,
  ): Promise<{ type: "timeout" } | { type: "health"; result: HealthRunResult }> {
    const signal = slot.abort?.signal ?? new AbortController().signal;
    const healthPromise = this.evaluateHealth(slot, signal).then(
      (result) => ({ type: "health" as const, result }),
      (error: unknown) => ({
        type: "health" as const,
        result: {
          ok: false,
          code: "health-failed" as const,
          detail: error instanceof Error ? error.message : String(error),
          outcomes: [] as HealthOutcome[],
          degraded: false,
        },
      }),
    );
    const timeoutPromise = this.sleep(slot.profile.startupTimeoutMs, signal).then(() => ({ type: "timeout" as const }));
    return Promise.race([healthPromise, timeoutPromise]);
  }

  private evaluateHealth(slot: ConcreteSlot, signal: AbortSignal): Promise<HealthRunResult> {
    if (this.healthOverride) return this.healthOverride(slot.profile, signal);
    const checks = withLiveness(slot.profile);
    const expected = this.expectation(slot);
    const probes: HealthProbes = {
      ...createDefaultHealthProbes(),
      processAlive: async (pid) => {
        if (slot.live && slot.live.pid === pid) return true;
        if (slot.ownership?.kind !== "process") return false;
        const snapshot = await this.inspector.inspect(pid);
        return classifyProcessProbe(slot.ownership, snapshot, this.sessionId).kind === "proven";
      },
      dockerService: expected ? composeProbe(this.compose, expected) : async () => ({ state: null, detail: "compose project is not claimed" }),
    };
    return runHealthChecks({
      checks,
      signal,
      deadlineAt: this.now() + slot.profile.startupTimeoutMs,
      now: this.now,
      sleep: this.sleep,
      probes,
      pid: slot.live?.pid ?? (slot.ownership?.kind === "process" ? slot.ownership.pid : null),
    });
  }

  private watchExit(slot: ConcreteSlot, live: SlotLive): void {
    void live.exited.then((exit) => {
      if (slot.generation !== live.generation || slot.live !== live) return;
      slot.live = null;
      slot.observed = {
        ownership: "none",
        processAlive: false,
        detail: exitDetail(exit),
        at: this.now(),
      };
      if (slot.stopRequested || slot.phase === "stopping" || slot.phase === "stopped") return;
      slot.ownership = null;
      slot.ownershipClass = "none";
      slot.lastError = `process exited unexpectedly (${exitDetail(exit)})`;
      slot.errorCode = "process-exited";
      slot.logs.append("system", slot.lastError, this.now());
      if (slot.phase === "starting" || slot.phase === "running" || slot.phase === "degraded") {
        this.assignPhase(slot, "error");
      }
      void this.persist(slot);
    });
  }

  private async waitUntilDead(pid: number, graceMs: number): Promise<boolean> {
    const deadline = this.now() + graceMs;
    let spins = 0;
    while (spins < 1000) {
      spins += 1;
      const snapshot = await this.inspector.inspect(pid);
      if (!snapshot) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(Math.min(50, Math.max(1, deadline - this.now())));
    }
    const snapshot = await this.inspector.inspect(pid);
    return snapshot === null;
  }

  private async raceExit(exited: Promise<ExitInfo>, graceMs: number, signal?: AbortSignal): Promise<boolean> {
    const winner = await Promise.race([
      exited.then(() => "exited" as const),
      this.sleep(graceMs, signal).then(() => "timeout" as const),
    ]);
    return winner === "exited";
  }

  private preflight(profile: LaunchProfile): { code: "missing-workdir" | "missing-compose-file"; error: string } | null {
    if (!existsSync(profile.projectPath) || !existsSync(profile.cwd)) {
      return { code: "missing-workdir", error: "working directory does not exist" };
    }
    let projectReal: string;
    let cwdReal: string;
    try {
      projectReal = realpathSync(profile.projectPath);
      cwdReal = realpathSync(profile.cwd);
    } catch {
      return { code: "missing-workdir", error: "working directory does not exist" };
    }
    if (!isLexicalInside(projectReal, cwdReal)) {
      return { code: "missing-workdir", error: "working directory escapes the project path" };
    }
    if (profile.launch.kind === "docker-compose") {
      const composeFile = path.join(cwdReal, profile.launch.composeFile);
      if (!isLexicalInside(projectReal, composeFile) || !existsSync(composeFile)) {
        return { code: "missing-compose-file", error: "compose file does not exist" };
      }
    }
    return null;
  }

  private locateCompose(profile: LaunchProfile): { ok: true; cwd: string; composeFile: string } | { ok: false; code: "missing-compose-file"; error: string } {
    if (profile.launch.kind !== "docker-compose") {
      return { ok: false, code: "missing-compose-file", error: "not a compose profile" };
    }
    try {
      const cwd = realpathSync(profile.cwd);
      const composeFile = realpathSync(path.join(cwd, profile.launch.composeFile));
      if (!isLexicalInside(cwd, composeFile)) {
        return { ok: false, code: "missing-compose-file", error: "compose file escapes the working directory" };
      }
      return { ok: true, cwd, composeFile };
    } catch {
      return { ok: false, code: "missing-compose-file", error: "compose file does not exist" };
    }
  }

  private expectation(slot: ConcreteSlot): ComposeExpectation | null {
    const profile = slot.profile;
    if (profile.launch.kind !== "docker-compose") return null;
    const ownership = slot.ownership?.kind === "compose" ? slot.ownership : null;
    let cwd = profile.cwd;
    let composeFile = path.join(profile.cwd, profile.launch.composeFile);
    try {
      cwd = realpathSync(profile.cwd);
      composeFile = realpathSync(composeFile);
    } catch {
      if (ownership) {
        cwd = ownership.cwd;
        composeFile = ownership.composeFile;
      }
    }
    return expectationFor(
      profile.id,
      ownership?.token ?? null,
      profile.launch.projectName,
      composeFile,
      cwd,
      ownership?.containerIds ?? [],
      ownership?.tokenApplied ?? false,
    );
  }

  private async fail(
    slot: ConcreteSlot,
    code: NonNullable<ConcreteSlot["errorCode"]>,
    error: string,
  ): Promise<EnvironmentOperationResult> {
    slot.lastError = error;
    slot.errorCode = code;
    slot.logs.append("system", error, this.now());
    if (slot.phase === "starting" || slot.phase === "stopping" || slot.phase === "running" || slot.phase === "degraded") {
      this.setPhase(slot, "error");
    }
    slot.observed = {
      ownership: slot.ownershipClass,
      processAlive: slot.live ? true : slot.observed.processAlive,
      detail: error,
      at: this.now(),
    };
    await this.persist(slot);
    return { ok: false, code, error, status: this.view(slot) };
  }

  private async markStopped(slot: ConcreteSlot): Promise<EnvironmentOperationResult> {
    slot.live = null;
    slot.ownership = null;
    slot.ownershipClass = "none";
    slot.lastError = null;
    slot.errorCode = null;
    slot.stopRequested = false;
    slot.extraSecrets = [];
    if (slot.phase !== "stopped") this.assignPhase(slot, "stopped");
    slot.observed = { ownership: "none", processAlive: false, detail: null, at: this.now() };
    this.clearMarker(slot.profile.id);
    await this.persist(slot);
    return { ok: true, status: this.view(slot) };
  }

  private clearMarker(profileId: string): void {
    const dir = path.join(this.markerDir, profileId);
    if (!isLexicalInside(this.markerDir, dir)) return;
    rmSync(dir, { recursive: true, force: true });
  }

  private setPhase(slot: ConcreteSlot, to: EnvironmentPhase, context: TransitionContext = {}): void {
    const refusal = transitionRefusal(slot.phase, to, context);
    if (refusal) throw new Error(refusal);
    this.assignPhase(slot, to);
  }

  /** Recovery assigns a phase loaded from a probe; it is not a user transition. */
  private assignPhase(slot: ConcreteSlot, to: EnvironmentPhase): void {
    slot.phase = to;
    slot.updatedAt = this.now();
  }

  private makeSlot(profile: LaunchProfile): ConcreteSlot {
    const at = this.now();
    const logs = new LogBuffer(LOG_BYTES);
    const slot: ConcreteSlot = {
      profile,
      phase: "stopped",
      ownership: null,
      ownershipClass: "none",
      lastError: null,
      errorCode: null,
      updatedAt: at,
      sessionId: null,
      live: null,
      stopRequested: false,
      generation: 0,
      lock: false,
      pending: null,
      abort: null,
      health: [],
      logs,
      observed: { ownership: "none", processAlive: null, detail: null, at: null },
      extraSecrets: [],
    };
    logs.onLine = (line) => this.emit(slot, line);
    return slot;
  }

  private secrets(slot: ConcreteSlot): string[] {
    const values: string[] = [];
    if (slot.ownership && slot.ownership.token.length >= 8) values.push(slot.ownership.token);
    for (const secret of slot.extraSecrets) {
      if (secret.length >= 8) values.push(secret);
    }
    for (const binding of slot.profile.env) {
      if (binding.from === "literal" && binding.value.length >= 8) values.push(binding.value);
    }
    return values;
  }

  private emit(slot: ConcreteSlot, line?: LogLine): void {
    if (!this.listener) return;
    try {
      this.listener({
        projectPath: slot.profile.projectPath,
        profileId: slot.profile.id,
        status: this.view(slot),
        line: line
          ? { stream: line.stream, at: line.at, text: redactEnvironmentText(line.text, this.secrets(slot)) }
          : undefined,
      });
    } catch {
      /* a listener must not break start, stop, or recovery */
    }
  }

  private view(slot: ConcreteSlot): EnvironmentStatus {
    const launch = slot.profile.launch;
    return {
      profileId: slot.profile.id,
      name: slot.profile.name,
      kind: launch.kind,
      recordedPhase: slot.phase,
      observed: { ...slot.observed },
      ownership: slot.ownershipClass,
      pid: slot.live?.pid ?? (slot.ownership?.kind === "process" ? slot.ownership.pid : null),
      composeProject: launch.kind === "docker-compose" ? launch.projectName : null,
      lastError: slot.lastError,
      errorCode: slot.errorCode,
      updatedAt: slot.updatedAt,
      health: slot.health.map((outcome) => ({ ...outcome })),
    };
  }

  private async persist(slot: ConcreteSlot): Promise<void> {
    await this.store.save({
      profile: slot.profile,
      runtime: {
        phase: slot.phase,
        ownership: slot.ownership,
        ownershipClass: slot.ownershipClass,
        lastError: slot.lastError,
        errorCode: slot.errorCode,
        updatedAt: slot.updatedAt,
        sessionId: slot.sessionId,
      },
    });
    this.emit(slot);
  }
}

function missing(id: string): EnvironmentOperationResult {
  return { ok: false, code: "not-found", error: `unknown environment ${id}`, status: null };
}

function busy(slot: ConcreteSlot, status: EnvironmentStatus): EnvironmentOperationResult {
  return { ok: false, code: "busy", error: `${slot.profile.id} is ${slot.phase}`, status };
}

function exitDetail(exit: ExitInfo): string {
  return `code ${exit.code ?? "null"}, signal ${exit.signal ?? "none"}`;
}

function labelsApplied(containers: readonly ComposeContainerSnapshot[], token: string): boolean {
  return containers.length > 0 && containers.every((container) => container.labels[FO_LABEL_TOKEN] === token);
}

function composeRecord(
  profile: LaunchProfile,
  expected: ComposeExpectation,
  containers: readonly ComposeContainerSnapshot[],
  tokenApplied: boolean,
): ComposeOwnershipRecord {
  return {
    kind: "compose",
    projectName: expected.projectName,
    composeFile: expected.composeFile,
    cwd: expected.workingDir,
    token: expected.token ?? "",
    tokenApplied,
    sessionId: "",
    profileId: profile.id,
    containerIds: containers.map((container) => container.id),
  };
}

function resolveServices(profile: LaunchProfile, text: string): { services: string[] } | { error: string } {
  if (profile.launch.kind !== "docker-compose") return { error: "not a compose profile" };
  const parsed = composeServiceNames(text);
  if (profile.launch.services.length > 0) {
    if (parsed.length > 0) {
      const known = new Set(parsed);
      for (const service of profile.launch.services) {
        if (!known.has(service)) return { error: `service ${service} is not declared in the compose file` };
      }
    }
    return { services: [...profile.launch.services] };
  }
  if (parsed.length === 0) {
    return { error: "could not read service names from the compose file; set launch.services" };
  }
  return { services: parsed };
}

function withLiveness(profile: LaunchProfile): LaunchProfile["healthChecks"] {
  const checks = [...profile.healthChecks];
  if (profile.launch.kind === "local-process") {
    if (!checks.some((check) => check.kind === "process-alive")) {
      checks.unshift({
        id: "liveness",
        kind: "process-alive",
        timeoutMs: 1_000,
        intervalMs: 0,
        maxAttempts: 1,
        required: true,
      });
    }
    return checks;
  }
  const services = profile.launch.services;
  for (const service of services) {
    if (checks.some((check) => check.kind === "docker-service" && check.service === service)) continue;
    checks.unshift({
      id: `service-${service}`,
      kind: "docker-service",
      service,
      timeoutMs: 1_000,
      intervalMs: 0,
      maxAttempts: 1,
      required: true,
    });
  }
  return checks;
}

/** Ensures the marker directory exists before a compose host writes into it. */
export function ensureMarkerDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
