import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOCK_CLEARANCE, setDockClearance, ShellDock } from "./ShellDock";

test("an empty dock renders nothing, so the shell DOM is unchanged when nothing is docked", () => {
  expect(renderToStaticMarkup(<ShellDock panelOpen={false} />)).toBe("");
  expect(renderToStaticMarkup(<ShellDock panelOpen>{false}</ShellDock>)).toBe("");
});

test("the dock sits on its own layer and moves left of an open RunPanel", () => {
  const closed = renderToStaticMarkup(<ShellDock panelOpen={false}><button>orb</button></ShellDock>);
  expect(closed).toContain("z-dock");
  expect(closed).toContain("right:1rem");
  const open = renderToStaticMarkup(<ShellDock panelOpen><button>orb</button></ShellDock>);
  expect(open).toContain("calc(var(--run-panel-width, 0px) + 1rem)");
});

test("clearance is reserved and released on the document root", () => {
  const props = new Map<string, string>();
  const root = { style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) } };
  setDockClearance(true, root);
  expect(props.get("--shell-dock-clearance")).toBe(DOCK_CLEARANCE);
  setDockClearance(false, root);
  expect(props.has("--shell-dock-clearance")).toBe(false);
});
