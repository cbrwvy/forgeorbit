/**
 * Parse `ps` output used to re-identify a process after ForgeOrbit restarts.
 * The inspector shells out; these functions stay pure so tests can feed fixtures.
 */

const LSTART =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/** `LC_ALL=C ps -o lstart=` → local epoch ms. Null when the line is not a timestamp. */
export function parseLstart(value: string): number | null {
  const match = LSTART.exec(value.trim());
  if (!match) return null;
  const monthName = match[1];
  if (!monthName) return null;
  const month = MONTHS[monthName];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);
  const year = Number(match[6]);
  if (!Number.isInteger(day) || !Number.isInteger(year)) return null;
  const date = new Date(year, month, day, hour, minute, second);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

export interface ProcessSnapshot {
  pid: number;
  startedAtMs: number | null;
  command: string;
  envToken: string | null;
}

export function extractEnvToken(commandLine: string, token: string): string | null {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const needle = `FORGEORBIT_ENV_TOKEN=${token}`;
  const at = commandLine.indexOf(needle);
  if (at < 0) return null;
  const before = at === 0 ? " " : commandLine[at - 1];
  const after = commandLine[at + needle.length];
  if (before && !/\s/.test(before)) return null;
  if (after && !/\s/.test(after)) return null;
  return token;
}
