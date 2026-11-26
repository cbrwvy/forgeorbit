// Local security delta against audited Electrobun 1.18.1. See scripts/electrobun-rpc-security.ts.
export default [
  [`initSocketToBun() {`, `async initSocketToBun() {`],
  [`		// Note: Using ws:// for localhost is intentional - all RPC messages are
		// encrypted with per-webview AES-GCM keys, making TLS redundant
		const socket = new WebSocket(
			\`ws://localhost:\${RPC_SOCKET_PORT}/socket?webviewId=\${WEBVIEW_ID}\`,
		);`, `		// FO-NATIVE003: per-view proof, short lifetime, single use. This also
		// pins IPv4 so localhost DNS/IPv6 cannot redirect the SDK transport.
		let proof: string;
		try {
			const issued = Date.now();
			const nonce = Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
				b => b.toString(16).padStart(2, "0")).join("");
			const key = await window.crypto.subtle.importKey("raw",
				new Uint8Array(window.__electrobunSecretKeyBytes),
				{ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const mac = await window.crypto.subtle.sign("HMAC", key,
				new TextEncoder().encode(\`fo-rpc-v1:\${WEBVIEW_ID}:\${issued}:\${nonce}\`));
			const hex = Array.from(new Uint8Array(mac), b => b.toString(16).padStart(2, "0")).join("");
			proof = \`fo-rpc-v1.\${issued}.\${nonce}.\${hex}\`;
		} catch {
			console.error("RPC socket authentication unavailable");
			return; // retain SDK's native postMessage fallback
		}
		const socket = new WebSocket(
			\`ws://127.0.0.1:\${RPC_SOCKET_PORT}/socket?webviewId=\${WEBVIEW_ID}\`, proof,
		);`]
  , [`\t\tthis.bunSocket = socket;`, `\t\tthis.bunSocket = socket;
\t\tconsole.log("FO-NATIVE003-VIEW-V1");`]
] satisfies [string, string][];
