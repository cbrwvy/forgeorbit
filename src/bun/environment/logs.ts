import type { LogLine } from "../../shared/environment/types.ts";

/** Bounded transcript for one environment. Drops the oldest text first. */
export class LogBuffer {
  private readonly lines: LogLine[] = [];
  private bytes = 0;
  /** Set by the manager after the slot exists. Must not throw. */
  onLine: ((line: LogLine) => void) | null = null;

  constructor(private readonly maxBytes: number) {}

  append(stream: LogLine["stream"], text: string, at: number): void {
    if (text.length === 0) return;
    const line: LogLine = { stream, text, at };
    this.lines.push(line);
    this.bytes += text.length;
    while (this.lines.length > 1 && this.bytes > this.maxBytes) {
      const removed = this.lines.shift();
      if (removed) this.bytes -= removed.text.length;
    }
    const only = this.lines[0];
    if (only && this.bytes > this.maxBytes) {
      const overflow = this.bytes - this.maxBytes;
      only.text = only.text.slice(overflow);
      this.bytes = only.text.length;
    }
    try {
      this.onLine?.(line);
    } catch {
      /* a listener must not break the process that is writing the log */
    }
  }

  snapshot(): LogLine[] {
    return this.lines.map((line) => ({ ...line }));
  }

  clear(): void {
    this.lines.length = 0;
    this.bytes = 0;
  }
}
