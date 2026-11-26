import type { BrowserRefusalCode } from "../shared/browser/types.ts";

export class BrowserSessionError extends Error {
  readonly status: number;
  readonly code: BrowserRefusalCode | "unauthorized";

  constructor(message: string, status: number, code: BrowserRefusalCode | "unauthorized") {
    super(message);
    this.name = "BrowserSessionError";
    this.status = status;
    this.code = code;
  }
}
