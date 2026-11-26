import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import {
  accountError,
  dateInput,
  moneyInput,
  nullableNumber,
  parseDate,
  parseMoney,
  unitLabel,
} from "@/lib/accounts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import type {
  Account,
  QuotaDefinition,
  QuotaUnit,
  Subscription,
} from "../../../shared/accounts/types.ts";

export interface ResourceForm {
  title: string;
  fields: ReactNode;
  save: (data: FormData) => Promise<unknown>;
  note?: string;
}
const value = (data: FormData, name: string) =>
  String(data.get(name) ?? "").trim();

/** Nested application Dialog supplies focus trapping, Escape and focus restoration. */
export function ResourceFormDialog({
  form,
  onClose,
  onSaved,
}: {
  form: ResourceForm;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  useUILocale();
  const titleId = useId();
  const firstFocus = useRef<HTMLHeadingElement>(null);
  const confirm = useConfirm();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const close = async () => {
    if (saving.current) return;
    if (
      !dirty ||
      (await confirm(() => ({
        title: tr("common.discard_unsaved_changes"),
        confirmLabel: tr("common.discard"),
        variant: "destructive",
      })))
    )
      onClose();
  };
  return createPortal(
    <Dialog
      open
      onClose={() => void close()}
      labelledBy={titleId}
      initialFocusRef={firstFocus}
      className="max-h-[85vh] max-w-xl overflow-y-auto"
    >
      <h2
        ref={firstFocus}
        tabIndex={-1}
        id={titleId}
        className="text-base font-semibold outline-none"
      >
        {staticLabel(form.title)}
      </h2>
      {form.note && (
        <p className="my-2 text-xs text-muted-foreground">{staticLabel(form.note)}</p>
      )}
      <form
        className="mt-4 space-y-4"
        onChange={() => setDirty(true)}
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving.current) return;
          const data = new FormData(event.currentTarget);
          saving.current = true;
          setBusy(true);
          setError(null);
          try {
            // Parsing errors are deliberately local, authored messages; API errors are sanitized separately.
            await form.save(data);
            setDirty(false);
            await onSaved();
            onClose();
          } catch (err) {
            setError(
              err instanceof FormValidationError
                ? err.message
                : accountError(err),
            );
          } finally {
            saving.current = false;
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
          {form.fields}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void close()}
          ><I18nText id="common.cancel" />{" "}</Button>
          <Button type="submit" disabled={busy}>
            {busy ? tr("common.saving_23e392") : tr("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>,
    document.body,
  );
}

class FormValidationError extends Error {}
function parsed<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new FormValidationError(
      error instanceof Error ? error.message : tr("common.check_the_entered_values"),
    );
  }
}
function Field({
  name,
  label,
  initial = "",
  required = false,
  type = "text",
  children,
  hint,
}: {
  name: string;
  label: string;
  initial?: string | number;
  required?: boolean;
  type?: string;
  children?: ReactNode;
  hint?: string;
}) {
  useUILocale();
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="text-xs font-medium">
        {staticLabel(label)}
      </label>
      {children ? (
        <Select
          id={id}
          name={name}
          defaultValue={initial}
          required={required}
          aria-describedby={hint ? `${id}-hint` : undefined}
        >
          {children}
        </Select>
      ) : (
        <Input
          id={id}
          name={name}
          defaultValue={initial}
          required={required}
          type={type}
          step={type === "datetime-local" ? "1" : undefined}
          maxLength={type === "text" ? 160 : undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
const options = (values: readonly string[]) =>
  values.map((v) => (
    <option key={v} value={v}>
      {v || tr("common.unknown")}
    </option>
  ));
const time = (data: FormData, name: string) =>
  parsed(() => parseDate(value(data, name)));

export function accountForm(account?: Account): ResourceForm {
  return {
    title: account ? tr("accounts.edit_metadata") : tr("accounts.create_account"),
    note: tr("common.registers_metadata_only_actual_cli_authentication_unknown_do"),
    fields: (
      <>
        {!account && <Field name="provider" label={tr("common.provider")} required />}
        <Field
          name="displayName"
          label={tr("accounts.display_name")}
          required
          initial={account?.displayName}
        />
        <Field
          name="externalIdentity"
          label={tr("accounts.external_identity_optional")}
          initial={account?.externalIdentity ?? ""}
        />
        <Field
          name="provenance"
          label={tr("accounts.identity_provenance")}
          initial={
            account?.provenance === "unknown" ? tr("common.unknown_b23a6a") : "user-provided"
          }
        >
          {options(["user-provided", "unknown"])}
        </Field>
        <Field
          name="availability"
          label={tr("accounts.declared_availability")}
          initial={account?.availability ?? tr("common.unknown_b23a6a")}
        >
          {options(["unknown", "available", "unavailable"])}
        </Field>
      </>
    ),
    save: (data) => {
      const input = {
        displayName: value(data, "displayName"),
        externalIdentity: value(data, "externalIdentity") || null,
        provenance: value(data, "provenance") as "unknown" | "user-provided",
        availability: value(data, "availability") as Account["availability"],
      };
      return account
        ? api.accountCore.updateAccount(account.id, input)
        : api.accountCore.createAccount({
            ...input,
            provider: value(data, "provider"),
          });
    },
  };
}
export function subscriptionForm(subscription?: Subscription): ResourceForm {
  return {
    title: subscription ? tr("accounts.edit_subscription") : tr("accounts.create_subscription"),
    note: tr("common.user_provided_unverified_blank_cost_means_unknown_totals"),
    fields: (
      <>
        {!subscription && <Field name="provider" label={tr("common.provider")} required />}
        <Field
          name="planLabel"
          label={tr("accounts.plan_label")}
          required
          initial={subscription?.planLabel}
        />
        <Field
          name="currency"
          label={tr("common.currency")}
          initial={subscription?.currency ?? ""}
          hint={tr("accounts.three_letter_code_e_g_usd_eur_jpy")}
        />
        <Field
          name="cost"
          label={tr("accounts.recurring_cost")}
          initial={moneyInput(
            subscription?.recurringCostMinor ?? null,
            subscription?.currency ?? null,
          )}
          hint={tr("accounts.decimal_amount_in_the_selected_currency_excess_decimal")}
        />
        <Field
          name="billingPeriod"
          label={tr("accounts.billing_period")}
          initial={subscription?.billingPeriod ?? tr("common.unknown_b23a6a")}
        >
          {options(["unknown", "month", "year", "week", "day"])}
        </Field>
        <Field
          name="renewsAt"
          label={tr("accounts.renewal_time")}
          type="datetime-local"
          initial={dateInput(subscription?.renewsAt)}
        />
        <Field
          name="resetsAt"
          label={tr("accounts.known_reset_time")}
          type="datetime-local"
          initial={dateInput(subscription?.resetsAt)}
        />
      </>
    ),
    save: (data) => {
      const currency = value(data, "currency").toUpperCase() || null;
      const input = {
        planLabel: value(data, "planLabel"),
        currency,
        recurringCostMinor: parsed(() =>
          parseMoney(value(data, "cost"), currency ?? ""),
        ),
        billingPeriod: value(
          data,
          "billingPeriod",
        ) as Subscription["billingPeriod"],
        renewsAt: time(data, "renewsAt"),
        resetsAt: time(data, "resetsAt"),
      };
      return subscription
        ? api.accountCore.updateSubscription(subscription.id, input)
        : api.accountCore.createSubscription({
            ...input,
            provider: value(data, "provider"),
          });
    },
  };
}
export function definitionForm(
  account: Account,
  subscriptions: Subscription[],
): ResourceForm {
  return {
    title: tr("accounts.create_quota_definition"),
    note: tr("common.unit_scope_and_window_are_immutable_correct_their"),
    fields: (
      <>
        <Field name="scope" label={tr("common.scope")} required initial="account" />
        <Field
          name="window"
          label={tr("accounts.window")}
          required
          initial="unknown"
          hint={tr("accounts.explicit_declaration_e_g_rolling_5h_or_instant")}
        />
        <Field name="kind" label={tr("accounts.unit")} initial="requests">
          {options([
            "requests",
            "tokens",
            "compute-time",
            "money",
            "concurrency",
            "provider-specific",
          ])}
        </Field>
        <Field name="timeUnit" label={tr("accounts.compute_time_unit")} initial="seconds">
          {options(["seconds", "milliseconds"])}
        </Field>
        <Field
          name="currency"
          label={tr("accounts.monetary_currency")}
          hint={tr("accounts.required_only_for_monetary_budget_quotas")}
        />
        <Field name="unitName" label={tr("accounts.provider_specific_unit_name")} />
        <Field name="subscriptionId" label={tr("accounts.subscription_identity")} initial="">
          <option value=""><I18nText id="accounts.no_subscription" /></option>
          {subscriptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.planLabel} · {s.id}
            </option>
          ))}
        </Field>
      </>
    ),
    save: (data) => {
      const kind = value(data, "kind") as QuotaUnit["kind"];
      const unit: QuotaUnit =
        kind === "money"
          ? { kind, currency: value(data, "currency").toUpperCase() }
          : kind === "compute-time"
            ? {
                kind,
                name: value(data, "timeUnit") as "seconds" | "milliseconds",
              }
            : kind === "provider-specific"
              ? { kind, name: value(data, "unitName") }
              : { kind };
      return api.accountCore.createDefinition({
        accountId: account.id,
        subscriptionId: value(data, "subscriptionId") || null,
        scope: value(data, "scope"),
        unit,
        window: value(data, "window"),
      });
    },
  };
}
export function observationForm(definition: QuotaDefinition): ResourceForm {
  return {
    title: tr("accounts.add_observation"),
    note: tr("common.append_only_manual_evidence_blank_values_remain_unknown", { p0: String(unitLabel(definition.unit)) }),
    fields: (
      <>
        <Field
          name="observedAt"
          label={tr("accounts.observed_at")}
          required
          type="datetime-local"
          initial={dateInput(Date.now())}
        />
        <Field
          name="expiresAt"
          label={tr("accounts.expires_at_freshness")}
          type="datetime-local"
        />
        <Field name="resetAt" label={tr("accounts.known_reset_time")} type="datetime-local" />
        <Field name="limit" label={tr("accounts.limit")} />
        <Field name="used" label={tr("accounts.used")} />
        <Field name="remaining" label={tr("accounts.remaining")} />
        <Field name="indicatorKind" label={tr("accounts.percentage_semantics")} initial="">
          <option value=""><I18nText id="accounts.no_percentage" /></option>
          {options(["percent-used", "percent-remaining"])}
        </Field>
        <Field name="percent" label={tr("accounts.percentage_0_100")} />
        <Field name="confidence" label={tr("common.confidence")} initial="unknown">
          {options(["unknown", "low", "medium", "high"])}
        </Field>
      </>
    ),
    save: (data) => {
      const number = (name: string) =>
        parsed(() =>
          nullableNumber(
            value(data, name),
            name !== "percent" &&
              ["money", "concurrency"].includes(definition.unit.kind),
          ),
        );
      const kind = value(data, "indicatorKind");
      const percent = number("percent");
      if (
        (kind && (percent === null || percent > 100)) ||
        (!kind && percent !== null)
      )
        throw new FormValidationError(
          "Choose percentage semantics and enter a value between 0 and 100, or leave both blank.",
        );
      return api.accountCore.recordObservation(definition.id, {
        observedAt: time(data, "observedAt")!,
        expiresAt: time(data, "expiresAt"),
        resetAt: time(data, "resetAt"),
        limit: number("limit"),
        used: number("used"),
        remaining: number("remaining"),
        indicator: kind
          ? {
              kind: kind as "percent-used" | "percent-remaining",
              value: percent!,
            }
          : null,
        confidence: value(data, "confidence") as
          | "unknown"
          | "low"
          | "medium"
          | "high",
      });
    },
  };
}
export function associationForm(
  title: string,
  label: string,
  choices: { id: string; label: string }[],
  save: (id: string) => Promise<unknown>,
  note?: string,
): ResourceForm {
  return {
    title,
    note,
    fields: (
      <Field name="associationId" label={staticLabel(label)} required initial="">
        <option value="" disabled><I18nText id="common.select" />{" "}</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} · {c.id}
          </option>
        ))}
      </Field>
    ),
    save: (data) => save(value(data, "associationId")),
  };
}
