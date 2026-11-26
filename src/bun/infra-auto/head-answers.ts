import { db } from "../db.ts";
import { InfraAutoService } from "./service.ts";

const service = new InfraAutoService(db);

/** Factual infrastructure answer for the unified Head of PM. Null sends the turn to the model. */
export function tryAnswerInfraQuestion(text: string): string | null {
  return service.answer(text);
}
