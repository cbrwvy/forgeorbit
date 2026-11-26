import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { employeeErrorText, isCurrentRequest } from "@/lib/employees";
import { subscribePortfolioRefresh } from "@/lib/portfolio-events";
import type { Employee, OrganizationTree } from "../../../../shared/employees/types.ts";

export interface CompanyData {
  tree: OrganizationTree | null;
  /** Every employee, archived included. The tree holds only the current structure. */
  all: Employee[];
  loading: boolean;
  error: string | null;
  /** Bumps on every successful load, so a card can re-read its own details. */
  version: number;
  reload: () => void;
}

/**
 * Reads the FO-010A API. Reloads when the page opens, when the window gains
 * focus, and on the portfolio refresh signal App already forwards from its
 * single event stream (a cluster move arrives that way). No timer, no second
 * stream, and nothing here writes.
 */
export function useCompanyData(): CompanyData {
  const [tree, setTree] = useState<OrganizationTree | null>(null);
  const [all, setAll] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const requestRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    void (async () => {
      try {
        const [organization, list] = await Promise.all([api.getOrganization(), api.listEmployees({ archived: true })]);
        if (!isCurrentRequest(requestId, requestRef.current)) return;
        setTree(organization);
        setAll(list.employees);
        setError(null);
        setVersion((current) => current + 1);
      } catch (err) {
        if (!isCurrentRequest(requestId, requestRef.current)) return;
        setError(employeeErrorText(err));
      } finally {
        if (isCurrentRequest(requestId, requestRef.current)) setLoading(false);
      }
    })();
  }, []);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (!disposed) loadRef.current(); }, 400);
    };
    loadRef.current();
    const unsubscribe = subscribePortfolioRefresh(() => schedule());
    const onVisible = () => { if (document.visibilityState === "visible") schedule(); };
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { tree, all, loading, error, version, reload: load };
}
