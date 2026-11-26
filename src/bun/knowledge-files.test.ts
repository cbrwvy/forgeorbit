import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKnowledgeFiles } from "./knowledge-files.ts";
import { KnowledgeError } from "./knowledge-error.ts";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "fo011c-files-"));
}

test("a markdown write is atomic and a failed rename leaves no partial note", () => {
  const root = path.join(scratch(), "knowledge");
  const id = randomUUID();
  const files = createKnowledgeFiles(root, { beforeRename: () => { throw new Error("disk"); } });
  expect(() => files.writeRevision(id, 1, Buffer.from("# half"))).toThrow(KnowledgeError);
  const bodies = path.join(root, "bodies", id);
  const names = readdirSync(bodies);
  expect(names.some((name) => name.endsWith(".md") || name.endsWith(".tmp"))).toBe(false);
});

test("a failure after rename removes the new file and keeps the previous revision", () => {
  const root = path.join(scratch(), "knowledge");
  const id = randomUUID();
  const ok = createKnowledgeFiles(root);
  ok.writeRevision(id, 1, Buffer.from("kept"));
  const failing = createKnowledgeFiles(root, { afterRename: () => { throw new Error("disk"); } });
  expect(() => failing.writeRevision(id, 2, Buffer.from("lost"))).toThrow(KnowledgeError);
  expect(new TextDecoder().decode(ok.readRevision(id, 1))).toBe("kept");
  expect(readdirSync(path.join(root, "bodies", id)).filter((name) => name.endsWith(".md"))).toEqual(["1.md"]);
});

test("path traversal and a symlinked note directory cannot leave the knowledge root", () => {
  const dir = scratch();
  const root = path.join(dir, "knowledge");
  const outside = path.join(dir, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "marker.txt"), "keep");
  const files = createKnowledgeFiles(root);
  expect(() => files.writeRevision("../../outside/pwn", 1, Buffer.from("no"))).toThrow(KnowledgeError);
  const id = randomUUID();
  mkdirSync(path.join(root, "bodies"), { recursive: true });
  symlinkSync(outside, path.join(root, "bodies", id));
  expect(() => files.writeRevision(id, 1, Buffer.from("no"))).toThrow(KnowledgeError);
  expect(readdirSync(outside)).toEqual(["marker.txt"]);
  expect(readFileSync(path.join(outside, "marker.txt"), "utf8")).toBe("keep");
  expect(lstatSync(path.join(root, "bodies", id)).isSymbolicLink()).toBe(true);
});

test("a symlinked knowledge root and a symlinked revision file are refused", () => {
  const dir = scratch();
  const outside = path.join(dir, "outside");
  const linkedRoot = path.join(dir, "knowledge");
  mkdirSync(outside);
  symlinkSync(outside, linkedRoot);
  const files = createKnowledgeFiles(linkedRoot);
  expect(() => files.writeRevision(randomUUID(), 1, Buffer.from("no"))).toThrow(KnowledgeError);
  expect(readdirSync(outside)).toEqual([]);

  const realRoot = path.join(dir, "real");
  const real = createKnowledgeFiles(realRoot);
  const id = randomUUID();
  real.writeRevision(id, 1, Buffer.from("secret"));
  const file = path.join(realRoot, "bodies", id, "1.md");
  rmSync(file);
  symlinkSync(path.join(outside, "marker.txt"), file);
  writeFileSync(path.join(outside, "marker.txt"), "elsewhere");
  expect(() => real.readRevision(id, 1)).toThrow(KnowledgeError);
  expect(readFileSync(path.join(outside, "marker.txt"), "utf8")).toBe("elsewhere");
});

test("a symlinked bodies directory cannot be used for reading, writing or deletion", () => {
  const dir = scratch();
  const root = path.join(dir, "knowledge");
  const outside = path.join(dir, "outside");
  const id = randomUUID();
  mkdirSync(path.join(outside, id), { recursive: true });
  writeFileSync(path.join(outside, id, "1.md"), "outside-body");
  mkdirSync(root);
  symlinkSync(outside, path.join(root, "bodies"));
  const files = createKnowledgeFiles(root);
  expect(() => files.readRevision(id, 1)).toThrow(KnowledgeError);
  expect(() => files.writeRevision(id, 2, Buffer.from("no"))).toThrow(KnowledgeError);
  expect(() => files.removeDocument(id)).toThrow(KnowledgeError);
  expect(readFileSync(path.join(outside, id, "1.md"), "utf8")).toBe("outside-body");
  expect(readdirSync(path.join(outside, id))).toEqual(["1.md"]);
});
