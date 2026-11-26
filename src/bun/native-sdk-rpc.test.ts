import { expect, test } from "bun:test";
import { createCipheriv, createHmac, randomBytes, webcrypto } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { connect as tcpConnect } from "node:net";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { electrobunRpcSecurity, electrobunViewSecurity, patchElectrobunRpc } from "../../scripts/electrobun-rpc-security.ts";

const sdk = path.resolve(import.meta.dir, "../../node_modules/electrobun/dist/api");
const key = "__foNative003Rpc";
const root = mkdtempSync(path.join(tmpdir(), "fo-native003-rpc-"));
let serial = 0;
const state = { calls: [] as unknown[] };
(globalThis as any)[key] = state;

async function buildSocket(patched = true, mock = "") {
  const entry = path.join(root, `entry-${serial++}.ts`);
  writeFileSync(entry, `export * from ${JSON.stringify(path.join(sdk, "bun/core/Socket.ts"))};`);
  const result = await Bun.build({ entrypoints: [entry], target: "bun", outdir: path.join(root, `out-${serial}`),
    plugins: [...(patched && !mock ? [electrobunRpcSecurity()] : []),
      { name: "synthetic-webviews", setup(build) {
        if (mock) build.onLoad({ filter: /core\/Socket\.ts$/ }, args => ({ loader: "ts", contents:
          mock + patchElectrobunRpc("socket", readFileSync(args.path, "utf8")) }));
        build.onResolve({ filter: /BrowserView(?:\.ts)?$/ }, () => ({ path: "synthetic-view", namespace: "synthetic" }));
        build.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ loader: "ts", contents: `
          export class BrowserView { static getById(id) { return [1,2,3,4].includes(id) ? {
            secretKey: new Uint8Array(32).fill(id === 2 ? 8 : 7), sandbox: id === 3, isRemoved: id === 4,
            rpcHandler: msg => globalThis.${key}.calls.push(msg)
          } : undefined; } }
        ` }));
      } }] });
  expect(result.success, result.logs.join("\n")).toBe(true);
  return result.outputs[0]!.path;
}
async function loadSocket(patched = true, mock = "") { return import(await buildSocket(patched, mock)); }
function proof(id = 1, byte = 7, issued = Date.now()) {
  const nonce = randomBytes(16).toString("hex");
  const mac = createHmac("sha256", Buffer.alloc(32, byte)).update(`fo-rpc-v1:${id}:${issued}:${nonce}`).digest("hex");
  return `fo-rpc-v1.${issued}.${nonce}.${mac}`;
}
function packet(byte = 7) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, byte), iv);
  const data = Buffer.concat([cipher.update('{"synthetic":true}'), cipher.final()]);
  return JSON.stringify({ encryptedData: data.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
}
async function opened(port: number, id: number, auth?: string) {
  const ws = auth ? new WebSocket(`ws://127.0.0.1:${port}/socket?webviewId=${id}`, auth)
    : new WebSocket(`ws://127.0.0.1:${port}/socket?webviewId=${id}`);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("upgrade rejected")); });
  return ws;
}
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  expect(check()).toBe(true);
}
async function tcp(host: string, port: number) {
  return new Promise<string>(resolve => {
    const socket = tcpConnect({ host, port });
    socket.setTimeout(1000);
    socket.on("connect", () => { socket.destroy(); resolve("connected"); });
    socket.on("error", (e: NodeJS.ErrnoException) => resolve(e.code || "error"));
    socket.on("timeout", () => { socket.destroy(); resolve("timeout"); });
  });
}
const external = Object.values(networkInterfaces()).flat().find(i => i && i.family === "IPv4" && !i.internal)?.address;

test("unmodified SDK: wildcard reachability and unauthenticated socket replacement reproduced with synthetic keys", async () => {
  const mod = await loadSocket(false);
  const sockets: WebSocket[] = [];
  try {
    // Bun's .hostname can say localhost while the kernel socket is wildcard.
    const listeners = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
    expect(listeners).toContain(`*:${mod.rpcPort} (LISTEN)`);
    console.log("NATIVE003 BEFORE kernel listener:", listeners.trim());
    const first = await opened(mod.rpcPort, 1); sockets.push(first);
    const before = mod.socketMap[1].socket;
    const attacker = await opened(mod.rpcPort, 1); sockets.push(attacker);
    expect(mod.socketMap[1].socket).not.toBe(before);
    const unknown = await opened(mod.rpcPort, 999); sockets.push(unknown);
    expect(unknown.readyState).toBe(WebSocket.OPEN);
    expect(await tcp("::1", mod.rpcPort)).toBe("connected");
    state.calls = [];
    attacker.send(packet(8)); await Bun.sleep(30); expect(state.calls).toHaveLength(0);
    attacker.send(packet(7)); await until(() => state.calls.length === 1);
    if (external) expect(await tcp(external, mod.rpcPort)).toBe("connected");
    console.log("NATIVE003 BEFORE", JSON.stringify({ hostname: mod.rpcServer.hostname, port: mod.rpcPort,
      nonLoopback: external ? "same-host interface TCP connected" : "UNVERIFIED: no interface" }));
  } finally { sockets.forEach(s => s.close()); mod.rpcServer.stop(true); }
});

test("patched RPC: loopback, authenticated clients, invalid handshakes, replay and socket ownership", async () => {
  const mod = await loadSocket();
  const sockets: WebSocket[] = [];
  try {
    expect(mod.rpcServer.hostname).toBe("127.0.0.1");
    expect(await tcp("127.0.0.1", mod.rpcPort)).toBe("connected");
    expect(await tcp("::1", mod.rpcPort)).toBe("ECONNREFUSED");
    if (external) expect(await tcp(external, mod.rpcPort)).toBe("ECONNREFUSED");
    for (const [id, auth] of [[1, undefined], [999, proof(999)], [3, proof(3)], [4, proof(4)],
      [1, proof(1, 8)], [1, proof(2)], [1, proof(1, 7, Date.now() - 11000)],
      [1, proof(1, 7, Date.now() + 60000)], [1, "invalid"]] as const) {
      await expect(opened(mod.rpcPort, id, auth)).rejects.toThrow("upgrade rejected");
    }
    expect(Object.keys(mod.socketMap)).toHaveLength(0);
    for (const id of ["1junk", "0", "01", "-1", "NaN", "9007199254740992"]) {
      expect((await fetch(`http://127.0.0.1:${mod.rpcPort}/socket?webviewId=${id}`)).status).toBe(400);
    }
    expect((await fetch(`http://127.0.0.1:${mod.rpcPort}/socket?webviewId=1`, { headers: { Host: `evil.invalid:${mod.rpcPort}` } })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${mod.rpcPort}/other`)).status).toBe(404);
    const auth = proof();
    const first = await opened(mod.rpcPort, 1, auth); sockets.push(first);
    const owner = mod.socketMap[1].socket;
    await expect(opened(mod.rpcPort, 1, auth)).rejects.toThrow();
    await expect(opened(mod.rpcPort, 1)).rejects.toThrow();
    expect(mod.socketMap[1].socket).toBe(owner);
    state.calls = [];
    first.send("plaintext"); first.send(packet(8)); await Bun.sleep(30);
    expect(state.calls).toHaveLength(0);
    first.send(packet()); await until(() => state.calls.length === 1);
    const replacement = await opened(mod.rpcPort, 1, proof()); sockets.push(replacement);
    const replacementOwner = mod.socketMap[1].socket;
    first.send(packet()); await Bun.sleep(30); expect(state.calls).toHaveLength(1);
    first.close(); await Bun.sleep(30); expect(mod.socketMap[1].socket).toBe(replacementOwner);
    const received = new Promise<string>(resolve => { replacement.onmessage = e => resolve(String(e.data)); });
    expect(mod.sendMessageToWebviewViaSocket(1, { reply: "synthetic" })).toBe(true);
    const encrypted = JSON.parse(await received);
    expect(encrypted.encryptedData).toBeString(); expect(encrypted.tag).toBeString();
    console.log("NATIVE003 AFTER", JSON.stringify({ hostname: mod.rpcServer.hostname, port: mod.rpcPort,
      ipv6: "refused", nonLoopback: external ? "same-host interface refused" : "UNVERIFIED: no interface" }));
  } finally { sockets.forEach(s => s.close()); mod.rpcServer.stop(true); }
});

test("occupied default port selects next port with the same loopback/auth policy", async () => {
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 50000, reusePort: false, fetch: () => new Response("fixture") });
  const mod = await loadSocket();
  try {
    expect(mod.rpcPort).toBe(50001); expect(mod.rpcServer.hostname).toBe("127.0.0.1");
    expect(await tcp("::1", mod.rpcPort)).toBe("ECONNREFUSED");
    if (external) expect(await tcp(external, mod.rpcPort)).toBe("ECONNREFUSED");
    await expect(opened(mod.rpcPort, 1)).rejects.toThrow();
    const ws = await opened(mod.rpcPort, 1, proof()); ws.close();
    const listeners = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
    expect(listeners).toContain("127.0.0.1:50001 (LISTEN)");
    console.log("NATIVE003 FALLBACK listener:", listeners.trim());
  } finally { mod.rpcServer.stop(true); blocker.stop(true); }
});

test("range exhaustion and non-conflict bind errors fail closed without widening hostname", async () => {
  for (const code of ["EADDRINUSE", "EACCES"]) {
    const mock = `const Bun = { serve(o) {
      if(o.hostname !== '127.0.0.1' || o.reusePort !== false) throw new Error('unsafe bind');
      if(o.port < 50000 || o.port > 65535) throw new Error('unsafe port');
      globalThis.__foNative003Attempts = (globalThis.__foNative003Attempts || 0) + 1;
      throw Object.assign(new Error('${code}'), {code:'${code}'});
    } }; const console = { log() {} };\n`;
    (globalThis as any).__foNative003Attempts = 0;
    await expect(loadSocket(true, mock)).rejects.toThrow(code === "EADDRINUSE" ? "ports exhausted" : "EACCES");
    expect((globalThis as any).__foNative003Attempts).toBe(code === "EADDRINUSE" ? 15536 : 1);
  }
});

test("real patched Electroview client authenticates with WebCrypto and exchanges encrypted RPC", async () => {
  const mod = await loadSocket();
  let ws: WebSocket | undefined;
  try {
    const browserSource = readFileSync(path.join(sdk, "browser/index.ts"), "utf8");
    const transformed = electrobunViewSecurity().transform(browserSource, path.join(sdk, "browser/index.ts"))!.code;
    const entry = path.join(root, "view.ts");
    writeFileSync(entry, `import { Electroview } from ${JSON.stringify(path.join(sdk, "browser/index.ts"))};
      import { initEncryption } from ${JSON.stringify(path.join(sdk, "bun/preload/encryption.ts"))};
      globalThis.ready = initEncryption().then(() => { globalThis.view = new Electroview({rpc: {
        setTransport(t) { t.registerHandler(msg => { globalThis.reply = msg; }); }
      }}); });`);
    const built = await Bun.build({ entrypoints: [entry], target: "browser", plugins: [{ name: "view-security", setup(b) {
      b.onLoad({ filter: /browser\/index\.ts$/ }, () => ({ loader: "ts", contents: transformed }));
    } }] });
    expect(built.success, built.logs.join("\n")).toBe(true);
    const window = { __electrobunWebviewId: 1, __electrobunRpcSocketPort: mod.rpcPort,
      __electrobunSecretKeyBytes: new Uint8Array(32).fill(7), crypto: webcrypto, __electrobun: {} };
    const context: any = { window, crypto: webcrypto, WebSocket, TextEncoder, TextDecoder, Uint8Array,
      ArrayBuffer, Buffer, btoa, atob, console, setTimeout, clearTimeout };
    runInNewContext(await built.outputs[0]!.text(), context);
    await context.ready; await until(() => context.view.bunSocket?.readyState === WebSocket.OPEN);
    ws = context.view.bunSocket;
    state.calls = [];
    await context.view.bunBridge('{"from":"actual-client"}');
    await until(() => state.calls.length === 1);
    expect(state.calls[0]).toEqual({ from: "actual-client" });
    expect(mod.sendMessageToWebviewViaSocket(1, { from: "server" })).toBe(true);
    await until(() => context.reply?.from === "server");
  } finally { ws?.close(); mod.rpcServer.stop(true); }
});

test("SDK drift is rejected and normal/QA bootstrap both install the security plugin", async () => {
  expect(() => patchElectrobunRpc("socket", "changed SDK")).toThrow("unreviewed");
  expect(() => patchElectrobunRpc("browser", "changed SDK")).toThrow("unreviewed");
  const { default: config } = await import("../../electrobun.config.ts");
  expect(config.build.bun.plugins[0]!.name).toBe("forgeorbit-native003");
  expect(config.build.bun.plugins[1]!.name).toBe("forgeorbit-native004");
  const source = readFileSync(path.resolve(import.meta.dir, "../../electrobun.config.ts"), "utf8");
  expect(source.match(/plugins: \[electrobunRpcSecurity\(\), electrobunLifecycle\(\)(?:, electrobunQaStorage\(\))?\]/g)).toHaveLength(2);
});

test("SDK listener works in the launcher-style Bun Worker with authenticated RPC and cleanup", async () => {
  const modulePath = await buildSocket();
  const workerPath = path.join(root, "worker.ts");
  writeFileSync(workerPath, `globalThis.${key} = { calls: [] };
    const mod = await import(${JSON.stringify(modulePath)});
    self.postMessage({hostname: mod.rpcServer.hostname, port: mod.rpcPort});
    self.onmessage = e => {
      if(e.data === 'stop') { mod.rpcServer.stop(true); self.close(); }
      else self.postMessage({calls: globalThis.${key}.calls});
    };`);
  const worker = new Worker(workerPath);
  let ws: WebSocket | undefined;
  const message = () => new Promise<any>((resolve, reject) => {
    worker.onmessage = e => resolve(e.data); worker.onerror = reject;
  });
  try {
    const ready = await message();
    expect(ready.hostname).toBe("127.0.0.1");
    ws = await opened(ready.port, 1, proof());
    ws.send(packet()); await Bun.sleep(30);
    const snapshot = message(); worker.postMessage("snapshot");
    expect((await snapshot).calls).toEqual([{ synthetic: true }]);
    ws.close();
    const exited = new Promise<void>(resolve => { worker.addEventListener("close", () => resolve()); });
    worker.postMessage("stop"); await exited;
    expect(await tcp("127.0.0.1", ready.port)).toBe("ECONNREFUSED");
  } finally { ws?.close(); worker.terminate(); }
});

test("version/source drift fails Bun.build instead of falling back to an unpatched bundle", async () => {
  const fixture = path.join(root, "drift");
  for (const dir of ["scripts", "patches/electrobun-1.18.1", "node_modules/electrobun/dist/api/bun/core"]) {
    mkdirSync(path.join(fixture, dir), { recursive: true });
  }
  const repo = path.resolve(import.meta.dir, "../..");
  for (const file of ["scripts/electrobun-rpc-security.ts", "patches/electrobun-1.18.1/socket.ts", "patches/electrobun-1.18.1/browser.ts"]) {
    copyFileSync(path.join(repo, file), path.join(fixture, file));
  }
  writeFileSync(path.join(fixture, "node_modules/electrobun/dist/api/bun/index.ts"), "export {};");
  writeFileSync(path.join(fixture, "node_modules/electrobun/dist/api/bun/core/Socket.ts"), "changed SDK");
  const entry = path.join(fixture, "entry.ts"); writeFileSync(entry, "console.log('inert fixture');");
  for (const version of ["1.18.2", "1.18.1"]) {
    writeFileSync(path.join(fixture, "node_modules/electrobun/package.json"), JSON.stringify({ version,
      exports: { "./bun": "./dist/api/bun/index.ts", "./view": "./dist/api/browser/index.ts" } }));
    const helper = await import(path.join(fixture, "scripts/electrobun-rpc-security.ts"));
    const build = async () => Bun.build({ entrypoints: [entry], target: "bun", plugins: [helper.electrobunRpcSecurity()] });
    await expect(build()).rejects.toThrow("NATIVE-003: unreviewed Electrobun");
  }
});
