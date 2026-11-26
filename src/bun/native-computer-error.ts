import type { NativeRefusalCode } from "../shared/native-computer/types.ts";

export class NativeComputerError extends Error {
  readonly status: number;
  readonly code: NativeRefusalCode | "unauthorized";

  constructor(message: string, status: number, code: NativeRefusalCode | "unauthorized") {
    super(message);
    this.name = "NativeComputerError";
    this.status = status;
    this.code = code;
  }
}
