import { afterEach, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { MemoryProposalCard, MemoryProposalOptIn, memoryProposalSendFields } from "./MemoryProposals";
import type { MemoryProposal } from "../../../../shared/brain/proposals.ts";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});

afterEach(async () => {
  await choose("en");
});

function proposal(status: MemoryProposal["status"]): MemoryProposal {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status,
    revision: status === "approved" ? 2 : 1,
    managerKind: "project-manager",
    sourceProjectPath: "/registry/alpha",
    conversationKey: "/registry/alpha",
    turnId: "turn-1",
    messageId: "message-1",
    scope: { kind: "project", id: "/registry/alpha" },
    companyScopeAllowed: false,
    claim: "owner-stated",
    sourceRef: "Owner said this in this conversation.",
    original: {
      title: "Rejected deployment strategy",
      kind: "decision",
      content: "The Owner rejected the proposed deployment strategy because it did not establish an acceptable security boundary.",
      fingerprint: "ab".repeat(32),
    },
    title: "Rejected deployment strategy",
    kind: "decision",
    content: "The Owner rejected the proposed deployment strategy because it did not establish an acceptable security boundary.",
    contentFingerprint: "ab".repeat(32),
    editedByOwner: false,
    decision: status === "approved" ? "approved" : null,
    decisionReason: null,
    decidedAt: status === "approved" ? 1 : null,
    memoryId: status === "approved" ? "22222222-2222-4222-8222-222222222222" : null,
    createdAt: 1,
    updatedAt: 1,
    duplicateWarning: status === "pending" ? { id: "33333333-3333-4333-8333-333333333333", title: "Already stored" } : null,
    events: [{ id: "event-1", kind: status === "approved" ? "approved" : "created", revision: 1, detail: "Proposed by the manager. Not a memory.", createdAt: 1 }],
    role: "data",
    executable: false,
    overridesRules: false,
  };
}

function render(node: ReactElement): string {
  return renderToStaticMarkup(<LocaleProvider>{node}</LocaleProvider>);
}

test("the per-turn control is off until the owner checks it", () => {
  const off = { allow: false, company: false, projectPaths: [] as string[] };
  expect(memoryProposalSendFields(off)).toEqual({});
  const html = render(
    <MemoryProposalOptIn mode="portfolio" projects={[{ path: "/registry/alpha", name: "Alpha" }]} value={off} onChange={() => {}} testId="memory-opt" />,
  );
  expect(html).toContain("Allow memory proposals");
  expect(html).not.toContain("Allow company-scope proposals");
  const on = render(
    <MemoryProposalOptIn
      mode="portfolio"
      projects={[{ path: "/registry/alpha", name: "Alpha" }]}
      value={{ allow: true, company: true, projectPaths: ["/registry/alpha"] }}
      onChange={() => {}}
      testId="memory-opt"
    />,
  );
  expect(on).toContain("This message only");
  expect(on).toContain("Alpha");
  expect(memoryProposalSendFields({ allow: true, company: true, projectPaths: ["/registry/alpha"] })).toEqual({
    allowMemoryProposals: true,
    allowCompanyMemoryProposals: true,
    memoryProposalProjectPaths: ["/registry/alpha"],
  });
});

test("review and approval states render in English and Russian", async () => {
  const pending = render(<MemoryProposalCard proposal={proposal("pending")} />);
  expect(pending).toContain("This is a proposal, not a Brain memory.");
  expect(pending).toContain("Rejected deployment strategy");
  expect(pending).toContain("A similar memory already exists: Already stored");
  expect(pending).toContain("Approve and save to Brain");
  expect(pending).toContain("Reject");
  expect(pending).toContain("data-testid=\"memory-proposal-approve\"");
  expect(pending).toContain("Decision history");
  expect(pending).not.toContain("Saved in Brain");

  const approved = render(<MemoryProposalCard proposal={proposal("approved")} />);
  expect(approved).toContain("Saved in Brain");
  expect(approved).toContain("22222222-2222-4222-8222-222222222222");
  expect(approved).not.toContain("data-testid=\"memory-proposal-approve\"");

  await choose("ru");
  const russian = render(<MemoryProposalCard proposal={proposal("pending")} />);
  expect(russian).toContain("Это предложение, а не запись памяти.");
  expect(russian).toContain("Одобрить и сохранить в память");
  expect(russian).toContain("Отнесено к вашим словам");
  expect(russian).toContain("Отклонить");
  const opt = render(
    <MemoryProposalOptIn mode="project" value={{ allow: true, company: false, projectPaths: [] }} onChange={() => {}} testId="memory-opt" />,
  );
  expect(opt).toContain("Разрешить предложения памяти");
  expect(opt).toContain("Только это сообщение");
});
