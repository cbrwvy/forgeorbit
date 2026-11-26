import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The QC observed test must run inside the existing offline macOS Seatbelt
// boundary with the project read-only. These tests run the real boundary.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-qc-seatbelt-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const roots: string[] = [];
function fixture(testSource: string, implementation: string | null = null): string {
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-qc-seatbelt-proj-")));
  roots.push(project);
  mkdirSync(path.join(project, "src"));
  writeFileSync(path.join(project, "package.json"), "{\"name\":\"fixture\",\"private\":true,\"type\":\"module\"}\n");
  writeFileSync(path.join(project, "src/probe.test.ts"), testSource);
  if (implementation) writeFileSync(path.join(project, "src/is-odd.ts"), implementation);
  return project;
}
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); rmSync(DATA_DIR, { recursive: true, force: true }); });

async function run(project: string) {
  const { executeApprovedTest } = await import("./review-evidence.ts");
  const { describeApprovedTest } = await import("../shared/review-evidence.ts");
  const proposed = describeApprovedTest("src/probe.test.ts", process.execPath)!;
  return executeApprovedTest({
    workspacePath: project, projectPath: project, testPath: "src/probe.test.ts",
    command: proposed.command, executable: proposed.executable, argv: proposed.argv, sourceFingerprint: "f".repeat(64),
  });
}

test("the approved test passes inside the offline boundary and records how it ran", async () => {
  const project = fixture([
    "import { expect, test } from \"bun:test\";",
    "import { isOdd } from \"./is-odd.ts\";",
    "test(\"odd\", () => { expect(isOdd(3)).toBe(true); expect(isOdd(4)).toBe(false); });",
    "",
  ].join("\n"), "export function isOdd(n: number): boolean { return Math.abs(n % 2) === 1; }\n");
  const result = await run(project);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.test.exitCode).toBe(0);
  expect(result.test.isolation).toBe("macos-offline-seatbelt");
  expect(result.test.provenance).toBe("forgeorbit-observed-test");
  expect(result.test.limitation).toContain("Seatbelt");
  expect(result.test.limitation).not.toContain("not securely isolated");
  expect(result.test.sourceFingerprint).toBe("f".repeat(64));
});

test("a failing test is a real observation, not a block", async () => {
  const project = fixture("import { expect, test } from \"bun:test\";\ntest(\"fails\", () => { expect(1).toBe(2); });\n");
  const result = await run(project);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.test.exitCode).not.toBe(0);
});

test("the test cannot reach the network, other folders, or write the project", async () => {
  let hits = 0;
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { hits += 1; }, data() {}, close() {} } });
  const canaryDir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-qc-seatbelt-canary-")));
  roots.push(canaryDir);
  const canary = path.join(canaryDir, "secret.txt");
  writeFileSync(canary, "CANARY-DO-NOT-LEAK");
  const project = fixture([
    "import { expect, test } from \"bun:test\";",
    "import { connect } from \"node:net\";",
    "import { readFileSync, writeFileSync } from \"node:fs\";",
    "test(\"denied: read outside the project\", () => { expect(() => readFileSync(" + JSON.stringify(canary) + ", \"utf8\")).toThrow(); });",
    "test(\"denied: write into the project\", () => { expect(() => writeFileSync(\"src/created-by-test.txt\", \"x\")).toThrow(); });",
    "test(\"denied: network\", async () => {",
    "  const error = await new Promise<Error | null>((resolve) => {",
    "    const socket = connect(" + listener.port + ", \"127.0.0.1\");",
    "    socket.on(\"connect\", () => { socket.destroy(); resolve(null); });",
    "    socket.on(\"error\", (e) => resolve(e));",
    "  });",
    "  expect(error).not.toBeNull();",
    "});",
    "",
  ].join("\n"));
  try {
    const result = await run(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.test.exitCode).toBe(0);
    expect(hits).toBe(0);
    expect(result.test.stdout + result.test.stderr).not.toContain("CANARY-DO-NOT-LEAK");
    expect(existsSync(path.join(project, "src/created-by-test.txt"))).toBe(false);
    expect(readdirSync(path.join(project, "src")).sort()).toEqual(["probe.test.ts"]);
  } finally {
    listener.stop(true);
  }
});

test("when the boundary cannot be built nothing runs and nothing is invented", async () => {
  const observed = await import("./autonomy/observed-test.ts");
  const marker = path.join(tmpdir(), `fo-qc-seatbelt-ran-${Date.now()}`);
  const project = fixture(`import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("would run", () => { writeFileSync(${JSON.stringify(marker)}, "ran"); });\n`);
  observed.setPracticalBoundaryFactoryForTest(() => { throw new Error("The Seatbelt boundary could not be built."); });
  try {
    const result = await run(project);
    expect(result).toEqual({ ok: false, reason: "The Seatbelt boundary could not be built." });
    expect(existsSync(marker)).toBe(false);
  } finally {
    observed.setPracticalBoundaryFactoryForTest(null);
    rmSync(marker, { force: true });
  }
});

test("a changed executable is still refused before anything is spawned", async () => {
  const { executeApprovedTest } = await import("./review-evidence.ts");
  const { describeApprovedTest } = await import("../shared/review-evidence.ts");
  const project = fixture("import { test } from \"bun:test\";\ntest(\"x\", () => {});\n");
  const proposed = describeApprovedTest("src/probe.test.ts", "/usr/bin/true")!;
  const result = await executeApprovedTest({
    workspacePath: project, projectPath: project, testPath: "src/probe.test.ts",
    command: proposed.command, executable: proposed.executable, argv: proposed.argv, sourceFingerprint: "f".repeat(64),
  });
  expect(result.ok).toBe(false);
  expect(readFileSync(path.join(project, "src/probe.test.ts"), "utf8")).toContain("test(");
});
