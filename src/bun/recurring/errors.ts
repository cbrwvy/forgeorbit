export class RecurringError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly code = "recurring-error",
  ) {
    super(message);
    this.name = "RecurringError";
  }
}
