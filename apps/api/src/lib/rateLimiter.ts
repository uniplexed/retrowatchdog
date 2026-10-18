/** Serializes async calls so consecutive starts are >= minIntervalMs apart. */
export class RateLimiter {
  private lastStart = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private minIntervalMs: number) {}

  /**
   * Change the pace in place (replacing the limiter would drop its queue and
   * clock). A 0 would remove pacing entirely, so it is ignored. Applies from
   * the NEXT call.
   */
  setInterval(ms: number): void {
    if (ms > 0) this.minIntervalMs = ms;
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = Date.now();
      return fn();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
