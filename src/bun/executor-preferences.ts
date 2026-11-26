/**
 * Owner executor-routing preferences (FO-ORCH01).
 *
 * Stored as one JSON value in the existing generic `preferences` table, so
 * there is no migration. Unreadable stored data reads as "no preferences".
 * These settings restrict or order choices; none of them grants permission.
 */
import {
  EXECUTOR_PREFERENCES_KEY,
  parseExecutorPreferences,
  readStoredExecutorPreferences,
  type ExecutorPreferences,
} from "../shared/execution/executor-routing.ts";
import { preferences } from "./db.ts";

export function loadExecutorPreferences(): ExecutorPreferences {
  return readStoredExecutorPreferences(preferences.get(EXECUTOR_PREFERENCES_KEY));
}

/** Validate and store. Throws the parser's message string on bad input. */
export function saveExecutorPreferences(raw: unknown): ExecutorPreferences {
  const parsed = parseExecutorPreferences(raw);
  preferences.set(EXECUTOR_PREFERENCES_KEY, JSON.stringify(parsed));
  return parsed;
}
