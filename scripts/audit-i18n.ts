/** Read-only JSX inventory. This checks authored text/attributes, not user/AI content or backend prose. */
import ts from "typescript";
import { en } from "../src/mainview/i18n/en";
import { ru } from "../src/mainview/i18n/ru";

// Reviewed brands, technical identifiers, command examples and endonyms. Never broaden this to hide UI copy.
const invariants = new Set<string>([
  "/Users/you/Projects/orbit",
  "/opt/homebrew/bin/claude",
  "AGENTS.md",
  "API",
  "BITBUCKET_EMAIL",
  "BITBUCKET_TOKEN",
  "CLAUDE.md",
  "English",
  "ForgeOrbit",
  "GH",
  "GITLAB_TOKEN",
  "Git",
  "HEAD",
  "IDEA.md",
  "KEY=value",
  "PATH",
  "PID",
  "PR",
  "PR #",
  "PRD.md",
  "README",
  "Run ID",
  "SIGINT",
  "SIGTERM",
  "Tmux",
  "bun",
  "claude-work",
  "custom-category",
  "email:api_token",
  "feature/",
  "feature/my-task",
  "fx login codex",
  "fx login grok",
  "gemini",
  "ghp_… / glpat-… / email:api_token",
  "github.com / gitlab.com / bitbucket.org",
  "glab",
  "http://127.0.0.1:3000/",
  "http://localhost:3000/",
  "layers",
  "mcp ·",
  "optional-slug",
  "origin/",
  "tmux",
  "v",
  "{ \"format\": \"agetor-bundle\", \"version\": 1, … }",
  "· HOME=",
  // Environment-variable name and example paths shown as input placeholders (FO-UX-SIMPLIFY02-M0).
  "CODEX_HOME:",
  "/path/to/project",
  "/path/to/folder",
  "/path/to/snapshot",
  "forgeorbit-restored-…"
]);
const raw: { file: string; line: number; kind: string; text: string }[] = [];
// FO-UX-SIMPLIFY02-M0: problem classes found by the UX audit that "raw JSX text" alone does not catch.
// Each hit is a failure; there is no allowlist for them. Fix the source instead.
const m0: { file: string; line: number; kind: "english-fallback" | "palette-class" | "english-conditional"; text: string }[] = [];
const PALETTE = /\b(?:text|bg|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|decoration|accent|caret|shadow)-(?:red|emerald|amber|blue|green|yellow|rose|sky|orange|indigo|purple|violet|pink|cyan|teal|lime|fuchsia)-\d{2,3}\b/g;
// Plain English words in a conditional/fallback string. Technical codes (lower-case, hyphenated, digits) never match.
const ENGLISH_WORDS = /^[A-Z][a-z]+(?: [A-Za-z]+)*$/;
let files = 0;
let references = 0;
for await (const file of new Bun.Glob("src/mainview/**/*.tsx").scan({ onlyFiles: true })) {
  if (file.includes("/i18n/") || file.includes(".test.")) continue;
  files++;
  const source = await Bun.file(file).text();
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const add = (node: ts.Node, text: string, kind: string) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (/[A-Za-z]/.test(normalized)) raw.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind, text: normalized });
  };
  const addM0 = (node: ts.Node, text: string, kind: (typeof m0)[number]["kind"]) =>
    m0.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind, text: text.replace(/\s+/g, " ").trim().slice(0, 100) });
  // A string literal that is a displayed branch of `cond ? "A" : "B"`, `x || "A"`, `x ?? "A"` or `x && "A"` directly inside a JSX child.
  function conditionalLiterals(node: ts.Expression): ts.StringLiteral[] {
    if (ts.isParenthesizedExpression(node)) return conditionalLiterals(node.expression);
    if (ts.isConditionalExpression(node)) return [...conditionalLiterals(node.whenTrue), ...conditionalLiterals(node.whenFalse)];
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      return [...conditionalLiterals(node.left), ...conditionalLiterals(node.right)];
    }
    return ts.isStringLiteral(node) ? [node] : [];
  }
  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) add(node, node.text, "text");
    if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
      for (const literal of conditionalLiterals(node.expression)) {
        if (ENGLISH_WORDS.test(literal.text.trim()) && !invariants.has(literal.text.trim())) addM0(literal, literal.text, "english-conditional");
      }
    }
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      && ts.isCallExpression(node.left) && /^(tr|t|translate)$/.test(node.left.expression.getText(ast)) && ts.isStringLiteral(node.right) && /[A-Za-z]{3}/.test(node.right.text)) {
      addM0(node.right, node.right.text, "english-fallback");
    }
    if (ts.isJsxAttribute(node) && /^(title|placeholder|aria-label|alt|label|description|hint|emptyLabel|searchPlaceholder)$/.test(node.name.getText(ast)) && node.initializer && ts.isStringLiteral(node.initializer)) add(node, node.initializer.text, "attribute");
    if (ts.isCallExpression(node) && /^(tr|t|translate)$/.test(node.expression.getText(ast))) references++;
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "I18nText") references++;
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
for await (const file of new Bun.Glob("src/mainview/**/*.{ts,tsx}").scan({ onlyFiles: true })) {
  if (file.includes("/i18n/") || file.includes(".test.")) continue;
  const lines = (await Bun.file(file).text()).split("\n");
  lines.forEach((text, index) => {
    for (const match of text.matchAll(PALETTE)) m0.push({ file, line: index + 1, kind: "palette-class", text: match[0] });
  });
}
const enKeys = Object.keys(en).sort(), ruKeys = Object.keys(ru).sort();
// Dictionary quality: same {placeholders} in both languages, and no Latin "Head of PM" left in Russian copy.
const placeholders = (value: string) => [...new Set([...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]!))].sort();
const dictionaryProblems: { key: string; problem: string }[] = [];
for (const key of enKeys) {
  const english = (en as Record<string, string>)[key]!, russian = (ru as Record<string, string>)[key];
  if (russian === undefined) continue;
  // Legacy split English nouns pass a plural-suffix placeholder that Russian copy legitimately omits; the reverse would print a raw "{name}".
  const known = new Set(placeholders(english));
  if (placeholders(russian).some(name => !known.has(name))) dictionaryProblems.push({ key, problem: "russian-placeholder-not-in-english" });
  if (/Head of PM/.test(russian)) dictionaryProblems.push({ key, problem: "latin-head-of-pm-in-russian" });
}
const missing = raw.filter(row => !invariants.has(row.text));
const namespaces: Record<string, number> = {};
for (const key of enKeys) { const namespace = key.split(".")[0]!; namespaces[namespace] = (namespaces[namespace] ?? 0) + 1; }
const result = {
  auditedTsxFiles: files,
  dictionaryKeys: enKeys.length,
  localeKeyParity: JSON.stringify(enKeys) === JSON.stringify(ruKeys),
  jsxTranslationReferences: references,
  rawInvariantOccurrences: raw.length - missing.length,
  rawInvariantUnique: new Set(raw.filter(row => invariants.has(row.text)).map(row => row.text)).size,
  untranslatedStatic: missing,
  m0Problems: m0,
  dictionaryProblems,
  namespaces,
  invariantInventory: raw,
};
console.log(JSON.stringify(result, null, 2));
if (missing.length || m0.length || dictionaryProblems.length || !result.localeKeyParity) process.exitCode = 1;
