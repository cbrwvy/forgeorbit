/**
 * Test-only replies for interview prompts under `AGETOR_*_DRIVER=fake`.
 * Reached only from `makeFakeAgent` (agents.ts), which only runs when a fake
 * driver env var is set — never on a real agent. Lets unit and e2e tests
 * drive a whole interview without spending anyone's AI quota.
 *
 * Markers an answer can carry:
 * - `__fake_interview_fail__` — the turn fails like a CLI error.
 * - `__fake_interview_slow__` — the reply takes 4 s (for cancel tests).
 * - `__fake_interview_garbage__` — the reply has no protocol tags.
 * - `__fake_interview_secret_error__` — fails with a credential in stderr
 *   (the runner must redact it before showing the error).
 */

export const FAKE_INTERVIEW_FAIL_MARKER = "__fake_interview_fail__";
export const FAKE_INTERVIEW_SLOW_MARKER = "__fake_interview_slow__";
export const FAKE_INTERVIEW_GARBAGE_MARKER = "__fake_interview_garbage__";
export const FAKE_INTERVIEW_SECRET_ERROR_MARKER = "__fake_interview_secret_error__";

const FAKE_QUESTIONS = [
  "What do you want to build, in one or two sentences?",
  "Who are the main users, and what problem does it solve for them?",
  "What must the first version (MVP) include?",
];

export function isInterviewPrompt(prompt: string): boolean {
  return prompt.startsWith("You are a product discovery assistant.");
}

export interface FakeInterviewReply {
  delayMs: number;
  code: number;
  assistant: string | null;
  stderr: string | null;
}

function answersOf(prompt: string): string[] {
  const out: string[] = [];
  for (const line of prompt.split("\n")) {
    if (line.startsWith("Person answered: ")) out.push(line.slice("Person answered: ".length).trim());
  }
  return out;
}

function projectName(prompt: string): string {
  const match = /^Project name: (.+)$/m.exec(prompt);
  return match?.[1]?.trim() || "Untitled";
}

function delayFor(prompt: string): number {
  if (prompt.includes(FAKE_INTERVIEW_SLOW_MARKER)) return 4000;
  const env = Number(process.env.AGETOR_FAKE_INTERVIEW_DELAY_MS ?? 0);
  return Number.isFinite(env) && env > 0 ? env : 30;
}

export function fakeInterviewReply(prompt: string): FakeInterviewReply {
  const delayMs = delayFor(prompt);
  if (prompt.includes(FAKE_INTERVIEW_SECRET_ERROR_MARKER)) {
    return { delayMs, code: 1, assistant: null, stderr: "auth failed for token sk-fakeSECRETfakeSECRETfake1234 (401)" };
  }
  if (prompt.includes(FAKE_INTERVIEW_FAIL_MARKER)) {
    return { delayMs, code: 1, assistant: null, stderr: "fake interview: the CLI exited with an error" };
  }
  if (prompt.includes(FAKE_INTERVIEW_GARBAGE_MARKER)) {
    return { delayMs, code: 0, assistant: `<other>${"x".repeat(2000)}</other>`, stderr: null };
  }
  const name = projectName(prompt);
  const answers = answersOf(prompt);
  if (prompt.includes("## Your task: ask the next question")) {
    const asked = (prompt.match(/^Assistant asked: /gm) ?? []).length;
    const finish = /^Person asked you: .*finish/im.test(prompt);
    if (finish || asked >= FAKE_QUESTIONS.length) {
      return {
        delayMs,
        code: 0,
        assistant: `<ready>I have enough to draft the documents for ${name}.</ready>`,
        stderr: null,
      };
    }
    return {
      delayMs,
      code: 0,
      assistant: [
        `<question>${FAKE_QUESTIONS[asked]}</question>`,
        "<assumptions>",
        "- Runs on macOS first",
        "</assumptions>",
        "<open_questions>",
        "- Pricing is not decided",
        "</open_questions>",
      ].join("\n"),
      stderr: null,
    };
  }
  if (prompt.includes("## Your task: write the drafts")) {
    const facts = answers.length > 0 ? answers.map((answer) => `- ${answer}`).join("\n") : "- (no answers)";
    const parts: string[] = ["Here are the drafts."];
    if (prompt.includes("- IDEA.md: missing.")) {
      parts.push(
        "<idea_md>",
        `# ${name}`,
        "",
        "## Product Summary",
        facts,
        "",
        "## Target Audience",
        "Confirmed by the person above.",
        "",
        "## Open Questions",
        "- Pricing is not decided",
        "</idea_md>",
      );
    }
    if (prompt.includes("- PRD.md: missing.")) {
      parts.push(
        "<prd_md>",
        `# ${name} PRD`,
        "",
        "## Product Overview",
        facts,
        "",
        "## Functional Requirements",
        "- FR-1: Fake requirement from the interview",
        "",
        "## Open Questions",
        "- Pricing is not decided",
        "</prd_md>",
      );
    }
    return { delayMs, code: 0, assistant: parts.join("\n"), stderr: null };
  }
  if (prompt.includes("## Your task: revise one section")) {
    const heading = /Rewrite only the section "([^"]+)"/.exec(prompt)?.[1] ?? "Section";
    const instruction = /^The person's instruction: (.+)$/m.exec(prompt)?.[1] ?? "";
    return {
      delayMs,
      code: 0,
      assistant: `<section_md>\n## ${heading}\n\nRevised section: ${instruction}\n</section_md>`,
      stderr: null,
    };
  }
  return { delayMs, code: 0, assistant: "<question>What do you want to build?</question>", stderr: null };
}
