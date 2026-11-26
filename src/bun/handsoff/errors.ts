export class HandsoffError extends Error {
  constructor(message: string, readonly status = 409, readonly code = "refused") { super(message); this.name = "HandsoffError"; }
}
