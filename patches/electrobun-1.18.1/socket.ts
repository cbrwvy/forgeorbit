// Local security delta against audited Electrobun 1.18.1. See scripts/electrobun-rpc-security.ts.
export default [
  [`randomBytes }`, `randomBytes, createHmac, timingSafeEqual }`],
  [`const startRPCServer = () => {`, `// FO-NATIVE003: authenticate before upgrade/socketMap mutation. Never log proofs.
const usedProofs = new Map<string, number>();
function authorizeRpc(req: Request, webviewId: number): string | null {
	const view = BrowserView.getById(webviewId);
	if (!view || view.sandbox || view.isRemoved) return null;
	const proof = req.headers.get("sec-websocket-protocol") || "";
	const match = /^fo-rpc-v1\\.(\\d{13})\\.([a-f0-9]{32})\\.([a-f0-9]{64})$/.exec(proof);
	if (!match) return null;
	const now = Date.now();
	const issued = Number(match[1]);
	if (issued > now || now - issued >= 10_000) return null;
	const expected = createHmac("sha256", view.secretKey)
		.update(\`fo-rpc-v1:\${webviewId}:\${match[1]}:\${match[2]}\`).digest();
	if (!timingSafeEqual(expected, Buffer.from(match[3]!, "hex"))) return null;
	for (const [key, expiry] of usedProofs) if (expiry <= now) usedProofs.delete(key);
	if (usedProofs.has(proof) || usedProofs.size >= 4096) return null;
	return proof;
}

const startRPCServer = () => {`],
  [`				port,`, `				port,
				hostname: "127.0.0.1", // FO-NATIVE003: including every fallback port
				reusePort: false,`],
  [`					//   const token = new URL(req.url).searchParams.get("token");
					//   if (token !== AUTH_TOKEN)
					//     return new Response("Unauthorized", { status: 401 });
					//   console.log("fetch!!", url.pathname);
					if (url.pathname === "/socket") {
						const webviewIdString = url.searchParams.get("webviewId");
						if (!webviewIdString) {
							return new Response("Missing webviewId", { status: 400 });
						}
						const webviewId = parseInt(webviewIdString, 10);
						const success = server.upgrade(req, { data: { webviewId } });
						return success
							? undefined
							: new Response("Upgrade failed", { status: 500 });
					}

					console.log("unhandled RPC Server request", req.url);`, `					if (req.method !== "GET" || url.host !== \`127.0.0.1:\${port}\`) {
						return new Response("Forbidden", { status: 403 });
					}
					if (url.pathname !== "/socket") return new Response("Not found", { status: 404 });
					const id = url.searchParams.get("webviewId") || "";
					if (!/^[1-9]\\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
						return new Response("Invalid webviewId", { status: 400 });
					}
					const webviewId = Number(id);
					const proof = authorizeRpc(req, webviewId);
					if (!proof) return new Response("Unauthorized", { status: 401 });
					const success = server.upgrade(req, {
						data: { webviewId }, headers: { "Sec-WebSocket-Protocol": proof },
					});
					if (!success) return new Response("Upgrade failed", { status: 400 });
					usedProofs.set(proof, Number(proof.split(".")[1]) + 10_000);
					return undefined;`],
  [`if (socketMap[webviewId]) {`, `if (socketMap[webviewId]?.socket === ws) {`],
  [`if (!browserView) {
							return;`, `if (!browserView || browserView.sandbox || browserView.isRemoved
							|| socketMap[webviewId]?.socket !== ws) {
							return;`],
  [`	return { rpcServer: server, rpcPort: port };`, `	if (!server) throw new Error("RPC loopback ports exhausted");
	return { rpcServer: server, rpcPort: port };`]
  , [`console.log("Server started at", rpcServer?.url.origin);`,
     `console.log("Server started at", rpcServer?.url.origin, "FO-NATIVE003-RPC-V1");`]
] satisfies [string, string][];
