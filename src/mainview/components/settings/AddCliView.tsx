import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Plus, Terminal } from "lucide-react";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { api, type HarnessInput } from "@/lib/api";
import { cn } from "@/lib/utils";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import {
  isValidCustomBin,
  parseArgString,
  slugifyHarnessId,
  type DiscoveredCli,
} from "../../../shared/custom-cli.ts";
import {
  HARNESS_TEMPLATES,
  type CustomInteractionMode,
  type CustomPromptDelivery,
  type DiscoveredAccount,
  type Harness,
  type HarnessTemplate,
} from "../../../shared/types.ts";

type AddTab = "detected" | "known" | "custom";

function uniqueId(base: string, existing: Set<string>): string {
  const clean = slugifyHarnessId(base);
  if (!existing.has(clean)) return clean;
  let n = 2;
  while (existing.has(`${clean}-${n}`)) n++;
  return `${clean}-${n}`;
}

function expandTilde(p: string | null, homeDir: string): string | null {
  if (!p) return null;
  if (!homeDir) return p;
  if (p.startsWith("~/")) return homeDir + p.slice(1);
  if (p === "~") return homeDir;
  return p;
}

function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key) env[key] = value;
  }
  return env;
}

export interface AddCliViewProps {
  discoveredClis: readonly DiscoveredCli[];
  existingHarnesses: readonly Harness[];
  homeDir: string;
  dataDir: string;
  onQuickConnect: (cli: DiscoveredCli) => Promise<void>;
  onPickTemplate: (template: HarnessTemplate) => void;
  onCreateCustom: (input: HarnessInput) => Promise<void>;
  onCancel: () => void;
}

export function AddCliView({
  discoveredClis,
  existingHarnesses,
  homeDir,
  onQuickConnect,
  onPickTemplate,
  onCreateCustom,
  onCancel,
}: AddCliViewProps) {
  useUILocale();
  const existingIds = useMemo(() => new Set(existingHarnesses.map((h) => h.id)), [existingHarnesses]);
  const connectableDetected = useMemo(
    () => discoveredClis.filter((d) => d.installed && !d.enabled),
    [discoveredClis],
  );

  const [tab, setTab] = useState<AddTab>(() => (connectableDetected.length > 0 ? "detected" : "custom"));
  const [discoveredClaude, setDiscoveredClaude] = useState<DiscoveredAccount[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Custom CLI form state
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [useExistingLogin, setUseExistingLogin] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [envText, setEnvText] = useState("");
  const [configDir, setConfigDir] = useState("");
  const [configDirEnv, setConfigDirEnv] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [modelFlag, setModelFlag] = useState("--model");
  const [effortFlag, setEffortFlag] = useState("");
  const [promptDelivery, setPromptDelivery] = useState<CustomPromptDelivery>("arg");
  const [promptFlag, setPromptFlag] = useState("");
  const [interactionMode, setInteractionMode] = useState<CustomInteractionMode>("manual");
  const [terminalArgsText, setTerminalArgsText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.discoverAccounts()
      .then((res) => { if (!cancelled) setDiscoveredClaude(res.accounts); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleQuickConnect = async (cli: DiscoveredCli) => {
    setBusyId(cli.serviceId);
    setError(null);
    try {
      await onQuickConnect(cli);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveCustom = async () => {
    setError(null);
    const trimmedName = name.trim();
    const trimmedCmd = command.trim();
    if (!trimmedName) {
      setError(tr("providersUi.add.err_name"));
      return;
    }
    if (!trimmedCmd || !isValidCustomBin(trimmedCmd)) {
      setError(tr("providersUi.add.err_command"));
      return;
    }
    const homeAbs = !useExistingLogin && configDir.trim()
      ? expandTilde(configDir.trim(), homeDir)
      : null;
    if (homeAbs && !homeAbs.startsWith("/")) {
      setError(tr("providersUi.add.err_home"));
      return;
    }
    const workdirAbs = workdir.trim() ? expandTilde(workdir.trim(), homeDir) : null;
    if (workdirAbs && !workdirAbs.startsWith("/")) {
      setError(tr("providersUi.add.err_workdir"));
      return;
    }

    const id = uniqueId(trimmedName, existingIds);
    const input: HarnessInput = {
      id,
      kind: "custom",
      label: trimmedName,
      bin: trimmedCmd,
      home: homeAbs,
      env: parseEnvLines(envText),
      cliConfig: {
        args: parseArgString(argsText),
        promptDelivery,
        promptFlag: promptFlag.trim() || null,
        interactionMode,
        workdir: workdirAbs,
        defaultModel: defaultModel.trim() || null,
        modelFlag: modelFlag.trim() || null,
        effortFlag: effortFlag.trim() || null,
        serviceId: id,
        homeEnvVar: !useExistingLogin && configDirEnv.trim() ? configDirEnv.trim() : null,
        terminalArgs: terminalArgsText.trim() ? parseArgString(terminalArgsText) : null,
      },
    };
    setSaving(true);
    try {
      await onCreateCustom(input);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const tabButton = (id: AddTab, label: string, count?: number) => (
    <button
      key={id}
      type="button"
      data-testid={`add-cli-tab-${id}`}
      onClick={() => { setTab(id); setError(null); }}
      className={cn(
        "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        tab === id
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="ml-1.5 rounded-full bg-primary/15 px-1.5 py-0.2 text-[10px] font-semibold text-primary">
          {count}
        </span>
      )}
    </button>
  );

  return (
    <div className="space-y-4 pt-2 text-sm" data-testid="add-cli-view">
      <p className="text-xs text-muted-foreground">{tr("providersUi.add.subtitle")}</p>

      <div className="flex flex-wrap gap-1 rounded-lg border border-border/60 bg-muted/30 p-1">
        {tabButton("detected", tr("providersUi.add.tab_detected"), connectableDetected.length)}
        {tabButton("known", tr("providersUi.add.tab_known"))}
        {tabButton("custom", tr("providersUi.add.tab_custom"))}
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {tab === "detected" && (
        <div className="space-y-2" data-testid="add-cli-detected-list">
          {discoveredClis.filter((d) => d.installed).length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
              {tr("providersUi.add.none_detected")}
            </p>
          ) : (
            discoveredClis
              .filter((d) => d.installed)
              .map((cli) => (
                <div
                  key={cli.serviceId}
                  data-testid={`detected-cli-${cli.serviceId}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <AgentIcon kind={cli.serviceId} className="size-4 shrink-0" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{cli.label}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {cli.explicitlyDisabled
                          ? tr("providersUi.add.disabled_hint")
                          : cli.description}
                      </div>
                    </div>
                  </div>
                  {cli.enabled ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
                      <Check className="size-3" />
                      {tr("providersUi.add.already_added")}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === cli.serviceId}
                      data-testid={`detected-cli-connect-${cli.serviceId}`}
                      onClick={() => void handleQuickConnect(cli)}
                    >
                      <Plus className="mr-1 size-3.5" />
                      {busyId === cli.serviceId
                        ? tr("providersUi.connecting")
                        : cli.explicitlyDisabled
                          ? tr("providersUi.enable")
                          : tr("providersUi.connect")}
                    </Button>
                  )}
                </div>
              ))
          )}
        </div>
      )}

      {tab === "known" && (
        <div className="space-y-3" data-testid="add-cli-known-list">
          {discoveredClaude.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                {tr("providersUi.add.detected_claude")}
              </div>
              {discoveredClaude.map((acc) => (
                <button
                  key={acc.configDir}
                  type="button"
                  onClick={() =>
                    onPickTemplate({
                      id: `__discovered:${acc.configDir}`,
                      label: tr("common.claude", { p0: String(acc.email) }),
                      description: "",
                      kind: "claude-code",
                      suggestedHarnessId: acc.suggestedHarnessId,
                      home: acc.configDir,
                      bin: null,
                      env: {},
                    })
                  }
                  className="flex w-full items-center gap-2.5 rounded-lg border border-border/60 px-3 py-2 text-left hover:border-primary/60 hover:bg-accent/40"
                >
                  <AgentIcon kind="claude-code" className="size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{acc.email}</div>
                    <div className="truncate text-xs text-muted-foreground">{acc.configDir}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            {discoveredClis
              .filter((d) => d.kind === "custom")
              .map((cli) => (
                <div
                  key={cli.serviceId}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <AgentIcon kind={cli.serviceId} className="size-4 shrink-0" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{cli.label}</div>
                      <div className="truncate text-xs text-muted-foreground">{cli.description}</div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === cli.serviceId}
                    data-testid={`known-cli-connect-${cli.serviceId}`}
                    onClick={() => void handleQuickConnect(cli)}
                  >
                    {cli.enabled ? tr("providersUi.add_account") : tr("providersUi.connect")}
                  </Button>
                </div>
              ))}

            {HARNESS_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => onPickTemplate(tpl)}
                className="flex w-full items-center gap-2.5 rounded-lg border border-border/60 px-3 py-2 text-left hover:border-primary/60 hover:bg-accent/40"
              >
                <AgentIcon kind={tpl.kind} className="size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{tpl.label}</div>
                  <div className="truncate text-xs text-muted-foreground">{tpl.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "custom" && (
        <div className="space-y-3" data-testid="add-cli-custom-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{tr("providersUi.add.name")}</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
                placeholder={tr("providersUi.add.name_placeholder")}
                data-testid="custom-cli-name"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{tr("providersUi.add.command")}</label>
              <Input
                {...IDENTIFIER_INPUT_PROPS}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                disabled={saving}
                placeholder={tr("providersUi.add.command_placeholder")}
                data-testid="custom-cli-bin"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{tr("providersUi.add.args")}</label>
            <Input
              {...IDENTIFIER_INPUT_PROPS}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              disabled={saving}
              placeholder={tr("providersUi.add.args_placeholder")}
              data-testid="custom-cli-args"
            />
          </div>

          <label className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={useExistingLogin}
              onChange={(e) => setUseExistingLogin(e.target.checked)}
              data-testid="custom-cli-use-existing-login"
            />
            <span>
              <span className="font-medium text-foreground">{tr("providersUi.add.use_existing_login")}</span>
              <span className="block text-muted-foreground">{tr("providersUi.add.use_existing_login_hint")}</span>
            </span>
          </label>

          <div className="rounded-lg border border-border/60">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              data-testid="custom-cli-advanced-toggle"
              className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <span>{tr("providersUi.additional_settings")}</span>
              {advancedOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>

            {advancedOpen && (
              <div className="space-y-3 border-t border-border/60 px-3 py-3" data-testid="custom-cli-advanced-fields">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">{tr("providersUi.add.prompt_delivery")}</label>
                    <Select
                      value={promptDelivery}
                      onChange={(e) => setPromptDelivery(e.target.value as CustomPromptDelivery)}
                      disabled={saving}
                      data-testid="custom-cli-prompt-delivery"
                    >
                      <option value="arg">{tr("providersUi.add.delivery.arg")}</option>
                      <option value="stdin">{tr("providersUi.add.delivery.stdin")}</option>
                      <option value="interactive">{tr("providersUi.add.delivery.interactive")}</option>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">{tr("providersUi.add.interaction_mode")}</label>
                    <Select
                      value={interactionMode}
                      onChange={(e) => setInteractionMode(e.target.value as CustomInteractionMode)}
                      disabled={saving}
                      data-testid="custom-cli-interaction-mode"
                    >
                      <option value="manual">{tr("providersUi.add.mode.manual")}</option>
                      <option value="automated">{tr("providersUi.add.mode.automated")}</option>
                    </Select>
                  </div>
                </div>

                {promptDelivery === "arg" && (
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">{tr("providersUi.add.prompt_flag")}</label>
                    <Input
                      {...IDENTIFIER_INPUT_PROPS}
                      value={promptFlag}
                      onChange={(e) => setPromptFlag(e.target.value)}
                      disabled={saving}
                      placeholder={tr("providersUi.add.prompt_flag_placeholder")}
                      data-testid="custom-cli-prompt-flag"
                    />
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">{tr("providersUi.add.default_model")}</label>
                    <Input
                      {...IDENTIFIER_INPUT_PROPS}
                      value={defaultModel}
                      onChange={(e) => setDefaultModel(e.target.value)}
                      disabled={saving}
                      placeholder={tr("providersUi.add.default_model_placeholder")}
                      data-testid="custom-cli-default-model"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">{tr("providersUi.add.model_flag")}</label>
                    <Input
                      {...IDENTIFIER_INPUT_PROPS}
                      value={modelFlag}
                      onChange={(e) => setModelFlag(e.target.value)}
                      disabled={saving}
                      placeholder={tr("providersUi.add.model_flag_placeholder")}
                      data-testid="custom-cli-model-flag"
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">{tr("providersUi.add.effort_flag")}</label>
                    <Input
                      {...IDENTIFIER_INPUT_PROPS}
                      value={effortFlag}
                      onChange={(e) => setEffortFlag(e.target.value)}
                      disabled={saving}
                      placeholder={tr("providersUi.add.effort_flag_placeholder")}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">{tr("providersUi.add.terminal_args")}</label>
                    <Input
                      {...IDENTIFIER_INPUT_PROPS}
                      value={terminalArgsText}
                      onChange={(e) => setTerminalArgsText(e.target.value)}
                      disabled={saving}
                      placeholder={tr("providersUi.add.terminal_args_placeholder")}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{tr("providersUi.add.workdir")}</label>
                  <Input
                    {...IDENTIFIER_INPUT_PROPS}
                    value={workdir}
                    onChange={(e) => setWorkdir(e.target.value)}
                    disabled={saving}
                    placeholder="/path/to/project"
                    data-testid="custom-cli-workdir"
                  />
                </div>

                {!useExistingLogin && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">{tr("providersUi.add.config_dir")}</label>
                      <Input
                        {...IDENTIFIER_INPUT_PROPS}
                        value={configDir}
                        onChange={(e) => setConfigDir(e.target.value)}
                        disabled={saving}
                        placeholder="/path/to/folder"
                        data-testid="custom-cli-home"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">{tr("providersUi.add.config_dir_env")}</label>
                      <Input
                        {...IDENTIFIER_INPUT_PROPS}
                        value={configDirEnv}
                        onChange={(e) => setConfigDirEnv(e.target.value)}
                        disabled={saving}
                        placeholder={tr("providersUi.add.config_dir_env_placeholder")}
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{tr("providersUi.add.env")}</label>
                  <Textarea
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                    disabled={saving}
                    rows={3}
                    className="font-mono text-xs"
                    placeholder="KEY=value"
                    data-testid="custom-cli-env"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-border/60 pt-3">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
              {tr("providersUi.add.back")}
            </Button>
            <Button size="sm" onClick={() => void handleSaveCustom()} disabled={saving} data-testid="custom-cli-save">
              <Terminal className="mr-1.5 size-3.5" />
              {tr("providersUi.add.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
