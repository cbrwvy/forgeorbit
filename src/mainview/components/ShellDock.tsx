import type { ReactNode } from "react";

/**
 * Bottom-right slot of the app shell (FO-UX02-C). FO-PM01 docks the floating
 * Head of PM (`head-pm/HeadOfPmDock`) here; with nothing docked it renders
 * nothing.
 *
 * Contract for whatever gets docked here:
 * - Layering: `z-dock` (35) — above page content and the RunPanel scrim (30),
 *   below the RunPanel itself (40), dialogs, popovers and context menus (50)
 *   and toasts. A modal dialog therefore always covers it, and its own focus
 *   trap keeps keyboard focus out of the dock while open.
 * - Placement: anchored to the work column, not the window. While the RunPanel
 *   is open the dock moves left by the panel's published width
 *   (`--run-panel-width`, the same signal the Toaster uses), so it can never
 *   sit on the panel's Send button.
 * - Clearance: the owner calls `setDockClearance(true)` while something is
 *   docked; scrolling pages (`pb-[calc(… + var(--shell-dock-clearance))]`) then
 *   keep their last row clear of it.
 * - Context: the dock is rendered outside `<main>` (a sibling in App), so the
 *   compact-layout `inert` on `<main>` does not disable it. It does not depend
 *   on the selected project — the docked component reads the workspace
 *   selection itself (Project or All-projects context). At compact widths App
 *   hides the docked content while the RunPanel or a compact panel covers the
 *   shell, and passes `panelOpen` false there (the panel is full width).
 */
export const DOCK_CLEARANCE = "4.5rem";

type StyleRoot = { style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown } };

/** Reserve (or release) bottom clearance on scrolling pages. */
export function setDockClearance(active: boolean, root: StyleRoot = document.documentElement): void {
  if (active) root.style.setProperty("--shell-dock-clearance", DOCK_CLEARANCE);
  else root.style.removeProperty("--shell-dock-clearance");
}

export function ShellDock({ panelOpen, children }: { panelOpen: boolean; children?: ReactNode }) {
  if (children == null || children === false) return null;
  return (
    <div
      data-testid="shell-dock"
      className="pointer-events-none fixed bottom-4 z-dock flex flex-col items-end gap-2 [&>*]:pointer-events-auto"
      style={{ right: panelOpen ? "calc(var(--run-panel-width, 0px) + 1rem)" : "1rem" }}
    >
      {children}
    </div>
  );
}
