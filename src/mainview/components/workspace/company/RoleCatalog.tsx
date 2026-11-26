import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Box,
  Check,
  ChevronRight,
  ClipboardList,
  Code,
  Copy,
  DollarSign,
  FlaskConical,
  Gamepad2,
  GraduationCap,
  LifeBuoy,
  type LucideIcon,
  Map,
  Megaphone,
  PenTool,
  Search,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Target,
  TrendingUp,
  UserCheck,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { DivisionMeta, RoleTemplate, RoleTemplateSummary } from "../../../../shared/catalog/types.ts";
import type { Employee } from "../../../../shared/employees/types.ts";

const DIVISION_ICONS: Record<string, LucideIcon> = {
  academic: GraduationCap,
  design: PenTool,
  engineering: Code,
  finance: DollarSign,
  "game-development": Gamepad2,
  gis: Map,
  healthcare: Stethoscope,
  marketing: Megaphone,
  "paid-media": Target,
  product: Box,
  "project-management": ClipboardList,
  research: Search,
  sales: TrendingUp,
  security: ShieldCheck,
  "spatial-computing": Boxes,
  specialized: Sparkles,
  support: LifeBuoy,
  testing: FlaskConical,
};

interface Props {
  employees?: Employee[];
  onOpenEmployee?: (id: string) => void;
  onRefreshCompany?: () => void;
}

export function RoleCatalog({ employees = [], onOpenEmployee, onRefreshCompany }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [roles, setRoles] = useState<RoleTemplateSummary[]>([]);
  const [divisions, setDivisions] = useState<DivisionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedDivision, setSelectedDivision] = useState<string>("all");

  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [activeRole, setActiveRole] = useState<RoleTemplate | null>(null);
  const [loadingRole, setLoadingRole] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // Assign to employee modal
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignTargetEmployeeId, setAssignTargetEmployeeId] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([api.getCatalogRoles(), api.getCatalogDivisions()])
      .then(([rolesRes, divRes]) => {
        if (cancelled) return;
        setRoles(rolesRes.roles);
        setDivisions(divRes.divisions);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : tr("common.failed_to_load_role_catalog"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch full role template on demand when clicked
  useEffect(() => {
    if (!activeSlug) {
      setActiveRole(null);
      return;
    }
    let cancelled = false;
    setLoadingRole(true);
    setCopiedPrompt(false);

    api
      .getCatalogRole(activeSlug)
      .then((res) => {
        if (cancelled) return;
        setActiveRole(res.role);
        setLoadingRole(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : tr("common.failed_to_load_role_details"));
        setLoadingRole(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSlug]);

  // Client-side filtering across roles
  const filteredRoles = useMemo(() => {
    let list = roles;
    if (selectedDivision !== "all") {
      list = list.filter((r) => r.division.toLowerCase() === selectedDivision.toLowerCase());
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.slug.toLowerCase().includes(q) ||
          (r.vibe && r.vibe.toLowerCase().includes(q)) ||
          r.division.toLowerCase().includes(q),
      );
    }
    return list;
  }, [roles, selectedDivision, search, uiLocale]);

  const copyPromptText = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // Fallback
    }
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const handleAssignToEmployee = async () => {
    if (!assignTargetEmployeeId || !activeRole) return;
    setAssigning(true);
    setAssignError(null);
    setAssignSuccess(null);

    try {
      await api.assignEmployeeProfessionalRole(assignTargetEmployeeId, {
        catalogRoleSlug: activeRole.slug,
        professionalTitle: activeRole.name,
        promptMarkdown: activeRole.originalMarkdown,
      });

      const emp = employees.find((e) => e.id === assignTargetEmployeeId);
      setAssignSuccess(`Assigned ${activeRole.name} to ${emp ? emp.name : "employee"}.`);
      onRefreshCompany?.();

      setTimeout(() => {
        setAssignDialogOpen(false);
        setAssignSuccess(null);
        if (onOpenEmployee) {
          onOpenEmployee(assignTargetEmployeeId);
        }
      }, 1000);
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : tr("common.failed_to_assign_role"));
    } finally {
      setAssigning(false);
    }
  };

  const activeDivision = divisions.find((d) => d.id === selectedDivision);

  return (
    <div className="flex flex-col gap-6" data-testid="role-catalog">
      {/* Header and Controls */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight" data-testid="catalog-title"><I18nText id="employees.role_catalog_library" />{" "}</h2>
            <p className="text-xs text-muted-foreground"><I18nText id="employees.283_offline_ai_professions_across_18_specialized_divisions" />{" "}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground" data-testid="catalog-count-badge">
              {filteredRoles.length} / {roles.length}{" "}<I18nText id="employees.roles" />{" "}</span>
          </div>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            id="catalog-search"
            data-testid="catalog-search"
            type="search"
            placeholder={tr("employees.search_professions_capabilities_specializations_or_tags")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-8"
          />
          {search && (
            <button
              type="button"
              aria-label={tr("employees.clear_search")}
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {/* Division Filter Pills */}
        <div
          role="radiogroup"
          aria-label={tr("employees.filter_by_division")}
          data-testid="catalog-division-filter"
          className="flex flex-wrap gap-1.5 overflow-x-auto pb-1"
        >
          <button
            type="button"
            role="radio"
            aria-checked={selectedDivision === "all"}
            data-testid="division-filter-all"
            onClick={() => setSelectedDivision("all")}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
              selectedDivision === "all"
                ? "border-primary bg-primary/10 font-medium text-foreground"
                : "border-border/60 hover:bg-muted/50 text-muted-foreground"
            }`}
          >
            <span><I18nText id="employees.all_divisions" /></span>
            <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">{roles.length}</span>
          </button>

          {divisions.map((div) => {
            const Icon = DIVISION_ICONS[div.id] || Code;
            const isSelected = selectedDivision === div.id;
            return (
              <button
                key={div.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                data-testid={`division-filter-${div.id}`}
                onClick={() => setSelectedDivision(div.id)}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                  isSelected
                    ? "border-primary bg-primary/10 font-medium text-foreground"
                    : "border-border/60 hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                <Icon className="size-3.5" style={{ color: div.color }} aria-hidden />
                <span>{staticLabel(div.label)}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">{div.count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content states */}
      {loading && (
        <div className="flex flex-col items-center justify-center p-12 text-sm text-muted-foreground" data-testid="catalog-loading">
          <p><I18nText id="employees.loading_role_catalog_library" /></p>
        </div>
      )}

      {error && !loading && (
        <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm text-destructive" data-testid="catalog-error">
          <p>{error}</p>
        </div>
      )}

      {!loading && !error && roles.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border p-12 text-sm text-muted-foreground" data-testid="catalog-empty">
          <p><I18nText id="employees.role_catalog_is_empty" /></p>
        </div>
      )}

      {!loading && !error && roles.length > 0 && filteredRoles.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border p-12 text-center" data-testid="catalog-no-results">
          <Search className="size-8 text-muted-foreground/50 mb-2" aria-hidden />
          <p className="text-sm font-medium"><I18nText id="employees.no_professions_match_your_filter" /></p>
          <p className="mt-1 text-xs text-muted-foreground"><I18nText id="employees.try_adjusting_your_search_query_or_selecting_a" />{" "}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => {
              setSearch("");
              setSelectedDivision("all");
            }}
          ><I18nText id="employees.reset_filters" />{" "}</Button>
        </div>
      )}

      {/* Role Cards Grid */}
      {!loading && !error && filteredRoles.length > 0 && (
        <div
          data-testid="catalog-grid"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {filteredRoles.map((role) => {
            const Icon = DIVISION_ICONS[role.division] || Code;
            return (
              <article
                key={role.slug}
                data-testid="role-card"
                data-role-slug={role.slug}
                onClick={() => setActiveSlug(role.slug)}
                className="group relative flex cursor-pointer flex-col justify-between rounded-xl border border-border/60 bg-card p-3.5 transition-all hover:border-primary/50 hover:shadow-sm"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-lg" aria-hidden>{role.emoji}</span>
                    <span
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                      style={{
                        backgroundColor: `${role.color || "#3B82F6"}18`,
                        color: role.color || "#3B82F6",
                      }}
                    >
                      <Icon className="size-2.5" aria-hidden />
                      {role.division}
                    </span>
                  </div>

                  <h3 className="mt-2 text-sm font-semibold tracking-tight text-foreground group-hover:text-primary transition-colors">
                    {role.name}
                  </h3>

                  <p className="mt-1 line-clamp-3 text-xs text-muted-foreground leading-relaxed">
                    {role.description}
                  </p>
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2 text-[11px] text-muted-foreground">
                  <span className="truncate font-mono">{role.slug}</span>
                  <ChevronRight className="size-3.5 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Role Detail Modal */}
      {activeSlug && (
        <Dialog
          open={Boolean(activeSlug)}
          onClose={() => setActiveSlug(null)}
          className="max-w-3xl max-h-[90vh] flex flex-col"
          data-testid="role-detail-modal"
        >
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden" data-testid="role-detail">
            {/* Modal Header */}
            <div className="flex items-start justify-between gap-3 border-b pb-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-2xl" aria-hidden>{activeRole?.emoji || "🤖"}</span>
                  <div>
                    <h2 className="text-lg font-semibold tracking-tight" data-testid="role-detail-name">
                      {activeRole?.name || activeSlug}
                    </h2>
                    <p className="font-mono text-xs text-muted-foreground">{activeRole?.slug || activeSlug}</p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="role-copy-prompt"
                  disabled={!activeRole}
                  onClick={() => activeRole && copyPromptText(activeRole.originalMarkdown)}
                >
                  {copiedPrompt ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                  {copiedPrompt ? tr("common.copied") : tr("common.copy_prompt")}
                </Button>

                <Button
                  type="button"
                  size="sm"
                  data-testid="role-use-for-employee"
                  disabled={!activeRole || employees.length === 0}
                  onClick={() => {
                    setAssignTargetEmployeeId(employees[0]?.id || "");
                    setAssignDialogOpen(true);
                  }}
                >
                  <UserCheck className="size-3.5" /><I18nText id="employees.use_for_employee" />{" "}</Button>

                <button
                  type="button"
                  data-testid="role-detail-close"
                  onClick={() => setActiveSlug(null)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  aria-label={tr("common.close")}
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto py-4 space-y-4">
              {loadingRole ? (
                <p className="text-sm text-muted-foreground"><I18nText id="employees.loading_role_prompt" /></p>
              ) : activeRole ? (
                <>
                  {/* Metadata Chips */}
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-md border bg-muted/30 px-2 py-1"><I18nText id="employees.division" />{" "}<strong className="font-medium capitalize">{activeRole.division}</strong>
                    </span>
                    <span className="rounded-md border bg-muted/30 px-2 py-1 font-mono"><I18nText id="employees.file" />{" "}{activeRole.sourcePath}
                    </span>
                    <span className="rounded-md border bg-muted/30 px-2 py-1 font-mono"><I18nText id="employees.commit" />{" "}{activeRole.sourceCommit.slice(0, 8)}
                    </span>
                    <span className="rounded-md border bg-muted/30 px-2 py-1 font-mono"><I18nText id="employees.sha_256" />{" "}{activeRole.sha256.slice(0, 12)}…
                    </span>
                    <span className="rounded-md border bg-muted/30 px-2 py-1"><I18nText id="employees.license_mit" />{" "}</span>
                  </div>

                  {/* Vibe */}
                  {activeRole.vibe && (
                    <div className="rounded-lg border bg-muted/20 p-2.5 text-xs text-muted-foreground">
                      <strong className="text-foreground"><I18nText id="employees.professional_vibe" /></strong> {activeRole.vibe}
                    </div>
                  )}

                  {/* Description */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"><I18nText id="common.description" /></h3>
                    <p className="mt-1 text-sm text-foreground leading-relaxed">{activeRole.description}</p>
                  </div>

                  {/* Markdown Prompt */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"><I18nText id="employees.original_markdown_instructions" />{" "}</h3>
                    <div
                      data-testid="role-markdown"
                      className="mt-2 rounded-xl border bg-muted/10 p-4 prose prose-sm dark:prose-invert max-w-none font-sans text-xs overflow-x-auto leading-relaxed"
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {activeRole.originalMarkdown}
                      </ReactMarkdown>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </Dialog>
      )}

      {/* Assign to Employee Dialog */}
      {assignDialogOpen && activeRole && (
        <Dialog
          open={assignDialogOpen}
          onClose={() => setAssignDialogOpen(false)}
          className="max-w-md"
          data-testid="assign-to-employee-modal"
        >
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="text-base font-semibold"><I18nText id="employees.assign_role_to_employee" /></h3>
              <p className="mt-0.5 text-xs text-muted-foreground"><I18nText id="common.assign" />{" "}<strong>{activeRole.name}</strong>{" "}<I18nText id="employees.specialization_and_prompt_instructions_to_an_existing_ai" />{" "}</p>
            </div>

            {assignError && (
              <p role="alert" className="text-xs text-destructive rounded border border-destructive/40 p-2">
                {assignError}
              </p>
            )}

            {assignSuccess && (
              <p role="status" className="text-xs text-success rounded border border-success/40 p-2">
                {assignSuccess}
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="assign-employee-select" className="text-xs font-medium"><I18nText id="employees.choose_employee" />{" "}</label>
              <Select
                id="assign-employee-select"
                data-testid="assign-employee-select"
                value={assignTargetEmployeeId}
                onChange={(e) => setAssignTargetEmployeeId(e.target.value)}
              >
                {employees
                  .filter((e) => e.status !== "archived")
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} ({e.jobTitle} · {e.kind})
                    </option>
                  ))}
              </Select>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAssignDialogOpen(false)}
                disabled={assigning}
              ><I18nText id="common.cancel" />{" "}</Button>
              <Button
                type="button"
                size="sm"
                data-testid="confirm-assign-button"
                disabled={assigning || !assignTargetEmployeeId}
                onClick={handleAssignToEmployee}
              >
                {assigning ? tr("common.assigning") : tr("common.assign_profession")}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
