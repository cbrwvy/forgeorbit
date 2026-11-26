import { abbreviateHome } from "./utils";

/**
 * Short, readable form of a folder path for headers and cards (FO-UX02-D stage 2).
 * The home folder collapses to `~`; a path deeper than `keep` segments keeps its
 * last `keep` ones behind a leading ellipsis (`…/projects/Orbit Notes`). The full
 * path always stays available as a tooltip and through the copy button, so no
 * technical data is lost — it just stops filling the row.
 */
export function shortenPath(path: string, homeDir = "", keep = 3): string {
  const home = abbreviateHome(path, homeDir);
  const parts = home.replace(/^(~\/|\/|~$)/, "").split("/").filter(Boolean);
  if (parts.length <= keep) return home;
  return `…/${parts.slice(-keep).join("/")}`;
}
