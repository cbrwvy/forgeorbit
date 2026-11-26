/**
 * Test isolation helper for ForgeOrbit backup and storage tests.
 * Ensures an isolated temporary dataDir is established and FORGEORBIT_DATA_DIR
 * is bound for all test processes and child workers.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Bind immediate fallback isolation upon module load if environment is not already isolated
if (!process.env.FORGEORBIT_DATA_DIR || !process.env.AGETOR_DATA_DIR) {
  try {
    const fallbackRoot = mkdtempSync(path.join(tmpdir(), "fo-test-module-init-"));
    const fallbackData = path.join(fallbackRoot, "data");
    mkdirSync(fallbackData, { recursive: true, mode: 0o700 });
    if (!process.env.FORGEORBIT_DATA_DIR) process.env.FORGEORBIT_DATA_DIR = fallbackData;
    if (!process.env.AGETOR_DATA_DIR) process.env.AGETOR_DATA_DIR = fallbackData;
  } catch {
    /* best effort */
  }
}

export interface IsolatedTestProfile {
  root: string;
  dataDir: string;
  cleanup: () => void;
}

/**
 * Creates an isolated temporary profile root and binds FORGEORBIT_DATA_DIR / AGETOR_DATA_DIR.
 * Fails closed immediately if the isolated directory cannot be created.
 */
export function setupIsolatedTestProfile(prefix = "fo-test-iso-"): IsolatedTestProfile {
  let root: string;
  try {
    root = mkdtempSync(path.join(tmpdir(), prefix));
  } catch (err) {
    throw new Error(`CRITICAL: Failed to establish isolated test profile fixture: ${(err as Error).message}`);
  }

  const dataDir = path.join(root, "data");
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`CRITICAL: Failed to establish isolated test dataDir fixture: ${(err as Error).message}`);
  }

  const prevForgeorbit = process.env.FORGEORBIT_DATA_DIR;
  const prevAgetor = process.env.AGETOR_DATA_DIR;

  process.env.FORGEORBIT_DATA_DIR = dataDir;
  process.env.AGETOR_DATA_DIR = dataDir;

  return {
    root,
    dataDir,
    cleanup: () => {
      if (prevForgeorbit !== undefined) {
        process.env.FORGEORBIT_DATA_DIR = prevForgeorbit;
      } else {
        delete process.env.FORGEORBIT_DATA_DIR;
      }

      if (prevAgetor !== undefined) {
        process.env.AGETOR_DATA_DIR = prevAgetor;
      } else {
        delete process.env.AGETOR_DATA_DIR;
      }

      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}
