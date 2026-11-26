/**
 * Brain 2.0 Specialist Controlled Memory Access Types (FO-BRAIN04).
 */

import type { BrainKind, BrainOrigin, BrainScope } from "./document.ts";

export type SpecialistRole = "developer" | "reviewer" | "devops" | "architect" | "worker";

export interface SpecialistBrainRequest {
  role: SpecialistRole;
  projectPath: string;
  taskId: string;
  taskPrompt?: string;
  maxChars?: number;
  maxMemories?: number;
}

export interface SpecialistFrozenMemory {
  id: string;
  revision: number;
  contentSha256: string;
  title: string;
}

export interface SpecialistBrainProvenance {
  accessedAt: number;
  role: SpecialistRole;
  projectPath: string;
  taskId: string;
  memories: SpecialistFrozenMemory[];
  relevanceNotes: {
    memoryId: string;
    reason: string;
    score: number;
  }[];
}

export interface SpecialistPromptMemory {
  id: string;
  revision: number;
  title: string;
  kind: BrainKind;
  scope: BrainScope;
  origin: BrainOrigin;
  content: string;
  snippet: string;
  contentSha256: string;
}

export interface SpecialistBrainContext {
  role: SpecialistRole;
  projectPath: string;
  taskId: string;
  memories: SpecialistPromptMemory[];
  provenance: SpecialistBrainProvenance;
  renderedMarkdown: string;
}
