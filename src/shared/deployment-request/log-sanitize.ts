/** Redact common secret patterns from deployment adapter output before persistence. */

const SECRET_PATTERNS: RegExp[] = [
  /(?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
];

export function sanitizeDeploymentLog(text: string, maxChars = 32_000): string {
  let out = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  if (out.length > maxChars) {
    out = `…${out.slice(out.length - maxChars)}`;
  }
  return out;
}
