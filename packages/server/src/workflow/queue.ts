import { describeError, logError } from "../log.ts";

export interface JobQueueOptions {
  /** Called with anything a job throws; default logs to console.error. */
  onError?: (id: string, err: unknown) => void;
  /** runs around every job (phase 4b, 4B-9: the JIRA mode is pinned for the whole job when it starts) */
  around?: (fn: () => Promise<void>) => Promise<void>;
}

/** In-process job queue with a concurrency limit; a job id that is queued or running is not enqueued again. */
export class JobQueue {
  readonly #concurrency: number;
  readonly #onError: (id: string, err: unknown) => void;
  readonly #around: (fn: () => Promise<void>) => Promise<void>;
  readonly #pending: Array<{ id: string; fn: () => Promise<void> }> = [];
  readonly #active = new Set<string>();
  #idleWaiters: Array<() => void> = [];

  constructor(concurrency: number, opts: JobQueueOptions = {}) {
    this.#concurrency = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
    // phase 4b (4B-2): the default log line is redacted (logError), with an AggregateError's parts
    this.#around = opts.around ?? ((fn) => fn());
    this.#onError = opts.onError ?? ((id, err) => logError(`job ${id} failed: ${describeError(err)}`));
  }

  enqueue(id: string, fn: () => Promise<void>): void {
    if (this.#active.has(id) || this.#pending.some((j) => j.id === id)) return;
    this.#pending.push({ id, fn });
    this.#pump();
  }

  idle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #isIdle(): boolean {
    return this.#active.size === 0 && this.#pending.length === 0;
  }

  #pump(): void {
    while (this.#active.size < this.#concurrency && this.#pending.length > 0) {
      const job = this.#pending.shift()!;
      this.#active.add(job.id);
      void (async () => {
        try {
          await this.#around(job.fn);
        } catch (err) {
          try {
            this.#onError(job.id, err);
          } catch {
            // a failing error handler must not stop the queue
          }
        } finally {
          this.#active.delete(job.id);
          this.#pump();
          if (this.#isIdle()) {
            const waiters = this.#idleWaiters;
            this.#idleWaiters = [];
            for (const w of waiters) w();
          }
        }
      })();
    }
  }
}
