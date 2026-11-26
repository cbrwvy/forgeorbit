import { filesSentCopy, shouldNotifyOsFilesSent } from "../lib/files-sent-notify";
import { staticLabel } from "./presentation";
import { moneyInput, moneyLabel, parseMoney } from "../lib/accounts";
import { afterEach, expect, test } from "bun:test";
import { localeStore } from "./core";
import * as view from "./options";
import * as canonical from "../../shared/types";
import { mergeModelOptions } from "./model-options";
import { mergeModelOptions as canonicalMerge } from "../../shared/model-options";
import { buildPreflightBody, buildStartBody, canConfirm, EMPTY_EXECUTION_DRAFT } from "../lib/employee-execution";
const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(() => choose("en"));

test("locale changes only option labels; all Runtime IDs, ordering and eligibility stay canonical", async () => {
  for (const locale of ["ru", "en"] as const) {
    await choose(locale);
    for (const kind of Object.keys(canonical.AGENT_OPTIONS) as canonical.AgentKind[]) {
      expect(view.AGENT_OPTIONS[kind].models.map(row => row.id)).toEqual(canonical.AGENT_OPTIONS[kind].models.map(row => row.id));
      expect(view.supportedModes(kind, null).map(row => row.id)).toEqual(canonical.supportedModes(kind, null).map(row => row.id));
      for (const model of canonical.AGENT_OPTIONS[kind].models) {
        expect(view.supportedEfforts(kind, model.id, ["low", "high"]).map(row => row.id)).toEqual(canonical.supportedEfforts(kind, model.id, ["low", "high"]).map(row => row.id));
      }
    }
    const input = { curated: [{ id: "known", label: "Auto", hint: "Cursor picks the model." }], discovered: [{ id: "custom", label: "Original Developer Name", efforts: ["high"] }], selected: "absent", scoped: true, loggedIn: false };
    const project = (rows: ReturnType<typeof canonicalMerge>) => rows.map(({label, hint, ...runtime}) => runtime);
    expect(project(mergeModelOptions(input))).toEqual(project(canonicalMerge(input)));
  }
});
test("cached metadata labels switch without mutating canonical records", async () => {
  await choose("en"); const modes = view.supportedModes("codex", null); const originals = JSON.stringify(canonical.AGENT_OPTIONS);
  expect(modes[0]?.label).toBe("Auto (sandboxed)"); await choose("ru");
  expect(modes[0]?.label).toBe("Авто (песочница)"); expect(JSON.stringify(canonical.AGENT_OPTIONS)).toBe(originals);
});
test("approval and request bodies stay identical in both languages, including unresolved launch blocking", async () => {
  const attempt = { revision: 7, usageNotice: "Immutable usage notice", requiresUnconfirmedAck: false };
  const before = buildStartBody(attempt, {usage:true,unconfirmed:false});
  for (const locale of ["en", "ru"] as const) {
    await choose(locale);
    expect(buildStartBody(attempt, {usage:true,unconfirmed:false})).toEqual(before);
    expect(buildPreflightBody("TASK_UUID", {...EMPTY_EXECUTION_DRAFT,harnessId:"codex",model:"gpt-6.1-sol"},3)).toEqual({taskId:"TASK_UUID",harnessId:"codex",model:"gpt-6.1-sol",effort:null,complexity:null,expectedAssignmentRevision:3});
    expect(canConfirm({status:"awaiting-approval",expiresAt:100,usageNotice:null,requiresUnconfirmedAck:true},{usage:true,unconfirmed:true},1)).toBe(false);
  }
});
test("multiple failed rapid preference writes restore the last confirmed setting", async () => {
  const { createLocaleStore } = await import("./core");
  const store = createLocaleStore("en");
  const fail = async () => { throw Error("offline"); };
  await Promise.allSettled([store.choose("ru", fail),store.choose("en",fail)]);
  expect(store.getSnapshot()).toBe("en");
  await store.choose("ru",async () => {});
  await expect(store.choose("en",fail)).rejects.toThrow("offline"); expect(store.getSnapshot()).toBe("ru");
});

test("Russian display keeps exact monetary minor units while form values stay canonical", async () => {
  await choose("ru");
  const minor = 9007199254740991;
  expect(moneyInput(minor,"USD")).toBe("90071992547409.91");
  expect(moneyLabel(minor,"USD")).toBe("USD 90\u00a0071\u00a0992\u00a0547\u00a0409,91");
  expect(parseMoney(moneyInput(minor,"USD"),"USD")).toBe(minor);
});

test("canonical approval copy translates while custom Owner requirements remain verbatim", async () => {
  await choose("ru");
  expect(staticLabel("Owner must approve any future execution.")).toBe("Любое последующее выполнение требует одобрения Владельца.");
  expect(staticLabel("CUSTOM_OWNER_REQUIREMENT_42")).toBe("CUSTOM_OWNER_REQUIREMENT_42");
});

test("notification labels translate without translating agent captions or changing notification policy", async () => {
  const caption = "Original English agent caption\nSecond line";
  await choose("ru");
  expect(filesSentCopy({count:2,caption})).toEqual({title:"Вам отправлено: 2 файла",body:"Original English agent caption"});
  expect(shouldNotifyOsFilesSent({isFocused:true,proactive:false})).toBe(false);
  expect(shouldNotifyOsFilesSent({isFocused:false,proactive:false})).toBe(true);
});
