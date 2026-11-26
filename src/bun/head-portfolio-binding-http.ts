import { changeHeadPortfolioBinding, getHeadPortfolioBinding } from "./portfolio-manager.ts";

/** Mounted behind the existing Owner bearer guard, before body parsing. */
export async function headPortfolioBindingHttp(req: Request): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  if (new URL(req.url).search) return reply({ error: "Query parameters are not accepted." }, 400);
  if (req.method === "GET") return reply(getHeadPortfolioBinding().value);
  if (req.method !== "PUT") return reply({ error: "not found" }, 404);
  const reader = req.body?.getReader();
  if (!reader) return reply({ error: "JSON body required." }, 400);
  let bytes = 0;
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); return reply({ error: "Body too large." }, 413); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(text); } catch { return reply({ error: "Invalid JSON." }, 400); }
  const result = changeHeadPortfolioBinding(body);
  return result.ok ? reply(result.value) : reply({ error: result.error }, result.status);
}
