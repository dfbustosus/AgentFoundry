/**
 * Tracer: the sink interface for trace events, plus three implementations.
 *
 * - NoopTracer:     discards; the zero-cost default.
 * - ConsoleTracer:  one JSON line per span on stdout — for demos and debugging.
 * - JsonlTracer:    append-only JSONL file, one line per span. Writes are
 *                   queued so concurrent emitters cannot interleave partial
 *                   lines, and `flush()` drains the queue (callers await it
 *                   before exiting).
 *
 * emit() is intentionally fire-and-forget at call sites (tracing must never
 * change the behavior of the traced code); durability is an explicit flush.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseTraceEvent, type TraceEvent } from "./events.js";

export interface Tracer {
  emit(event: TraceEvent): void;
  /** Drain buffered writes. Optional for sinks without buffering. */
  flush?: () => Promise<void>;
}

export class NoopTracer implements Tracer {
  emit(_event: TraceEvent): void {}
}

export class ConsoleTracer implements Tracer {
  constructor(private readonly log: (line: string) => void = console.log) {}
  emit(event: TraceEvent): void {
    this.log(JSON.stringify(event));
  }
}

export class JsonlTracer implements Tracer {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  emit(event: TraceEvent): void {
    // Chain writes: span N+1 is appended only after span N is durable.
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  /** Read and validate every span in the file. Corrupt lines fail loudly. */
  static async readAll(filePath: string): Promise<TraceEvent[]> {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => parseTraceEvent(JSON.parse(line)));
  }
}

/** Id helpers — correlation ids are stable, span ids unique. */
export function newTraceId(): string {
  return randomUUID();
}

export function newSpanId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
