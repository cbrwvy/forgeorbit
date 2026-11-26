import type { Database } from "bun:sqlite";
import type { HeadPortfolioBinding, HeadSnapshot, PortfolioTurnAttribution } from "../shared/head-portfolio-binding.ts";

export class HeadBindingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
interface BindingRow {
  employee_id: string | null; job_title: string | null; role_category: string | null;
  employee_event_id: number; revision: number;
}
interface EmployeeRow {
  id: string; name: string; kind: string; job_title: string; role_category: string; status: string; archived_at: number | null;
}
export class HeadPortfolioBindingCore {
  constructor(private readonly db: Database, private readonly busy: () => boolean = () => false) {}
  private row(): BindingRow {
    return this.db.query<BindingRow, []>("SELECT * FROM head_portfolio_binding WHERE id = 'global'").get()!;
  }
  private employee(id: string): EmployeeRow | null {
    return this.db.query<EmployeeRow, [string]>("SELECT * FROM ai_employees WHERE id = ?").get(id);
  }
  private snapshot(e: EmployeeRow): HeadSnapshot {
    return { employeeId: e.id, name: e.name, kind: "head", jobTitle: e.job_title, roleCategory: e.role_category };
  }
  get(): HeadPortfolioBinding {
    return this.db.transaction(() => {
      const row = this.row();
      const base = { sessionId: "global" as const, revision: row.revision, employeeId: row.employee_id };
      if (!row.employee_id) return { ...base, status: "unbound" as const, head: null, employeeStatus: null, reason: null };
      const e = this.employee(row.employee_id);
      const changed = this.db.query<{ n: number }, [string, number]>(`SELECT COUNT(*) AS n FROM ai_employee_events
        WHERE employee_id = ? AND id > ? AND (action IN ('archive', 'unarchive')
          OR json_type(changes, '$.jobTitle') IS NOT NULL OR json_type(changes, '$.roleCategory') IS NOT NULL
          OR json_type(changes, '$.status') IS NOT NULL)`).get(row.employee_id, row.employee_event_id)!.n > 0;
      const valid = e && e.kind === "head" && e.status === "active" && e.archived_at === null
        && e.job_title === row.job_title && e.role_category === row.role_category && !changed;
      return { ...base, status: valid ? "bound" as const : "invalid" as const,
        head: e?.kind === "head" ? this.snapshot(e) : null, employeeStatus: e?.status ?? null,
        reason: valid ? null : "Head identity or position changed. Owner must explicitly confirm a valid Head again." };
    })();
  }
  change(input: unknown): HeadPortfolioBinding {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HeadBindingError("Expected a binding confirmation.");
    const v = input as Record<string, unknown>;
    if (Object.keys(v).sort().join(",") !== "confirm,employeeId,revision" || v.confirm !== true
      || !Number.isSafeInteger(v.revision) || (v.revision as number) < 0
      || (v.employeeId !== null && (typeof v.employeeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.employeeId)))) {
      throw new HeadBindingError("Expected employeeId, revision and confirm: true only.");
    }
    return this.db.transaction(() => {
      const row = this.row();
      if (row.revision !== v.revision) throw new HeadBindingError("Binding changed. Review the current revision before confirming.", 409);
      const e = v.employeeId === null ? null : this.employee(v.employeeId as string);
      if (v.employeeId !== null && !e) throw new HeadBindingError("Head employee not found.", 404);
      if (e && (e.kind !== "head" || e.status !== "active" || e.archived_at !== null)) throw new HeadBindingError("Binding requires an active, unarchived Head.", 409);
      const current = this.get();
      if (row.employee_id === v.employeeId && current.status !== "invalid") return current;
      if (this.busy()) throw new HeadBindingError("Wait for the current portfolio turn or delegation send to finish before changing Head binding.", 409);
      const watermark = e ? this.db.query<{ id: number }, [string]>("SELECT COALESCE(MAX(id), 0) AS id FROM ai_employee_events WHERE employee_id = ?").get(e.id)!.id : 0;
      const now = Date.now();
      this.db.run(`UPDATE head_portfolio_binding SET employee_id = ?, job_title = ?, role_category = ?, employee_event_id = ?, revision = revision + 1, updated_at = ? WHERE id = 'global' AND revision = ?`,
        [e?.id ?? null, e?.job_title ?? null, e?.role_category ?? null, watermark, now, row.revision]);
      this.db.run("INSERT INTO head_portfolio_binding_events VALUES (?, ?, ?, 'owner', ?)", [row.revision + 1, row.employee_id, e?.id ?? null, now]);
      return this.get();
    }).immediate();
  }
  capture(turnId: string, projectPaths: string[]): PortfolioTurnAttribution {
    const binding = this.get();
    const head = binding.status === "bound" ? binding.head : null;
    return { sessionId: "global", turnId, bindingRevision: binding.revision, bindingStatus: binding.status,
      head, scope: { kind: "portfolio", projectPaths: [...projectPaths] }, capturedAt: Date.now(),
      provenance: head ? "owner-confirmed-binding" : "legacy-unattributed" };
  }
}
