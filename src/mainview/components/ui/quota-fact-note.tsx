import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import type { QuotaFactKind } from "../../../shared/accounts/availability.ts";

/**
 * Says which kinds of quota reading are on record behind a "Quota Unknown" state, so a reading you reported,
 * a provider diagnostic and a past reading are not all worded as "nothing". It never states a balance.
 */
export function QuotaFactNote({ facts, testId }: { facts: readonly QuotaFactKind[] | undefined; testId: string }) {
  useUILocale();
  if (!facts) return null;
  const keys = (["owner-reported", "observed", "historical"] as const).filter((k) => facts.includes(k));
  if (keys.length === 0) return null;
  return (
    <span className="mt-0.5 block text-muted-foreground" data-testid={testId} data-facts={keys.join(" ")}>
      {keys.map((k) => tr(`d11.preflight.${k}` as "d11.preflight.historical")).join(" ")}
    </span>
  );
}
