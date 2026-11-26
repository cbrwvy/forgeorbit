/**
 * Rendering policy for knowledge Markdown.
 *
 * Notes are untrusted text. Links and images do not become local file reads.
 * A remote image stays blocked until the reader asks to show it.
 */

const CONTROL = /[\u0000-\u001f\u007f]/;

export function knowledgeLinkPolicy(href: string): "external" | "blocked" {
  const value = href.trim();
  if (value.length === 0 || value.length > 2048 || CONTROL.test(value)) return "blocked";
  if (/^(https?:|mailto:)/i.test(value)) return "external";
  return "blocked";
}

export function knowledgeImagePolicy(src: string): "remote" | "blocked" {
  const value = src.trim();
  if (value.length === 0 || value.length > 2048 || CONTROL.test(value)) return "blocked";
  if (/^https:\/\//i.test(value)) return "remote";
  return "blocked";
}
