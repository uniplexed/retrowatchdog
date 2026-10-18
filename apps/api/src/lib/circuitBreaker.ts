export class CircuitOpenError extends Error {
  constructor() {
    super("circuit open");
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(
    private readonly opts: { failureThreshold: number; holdMs: number },
  ) {}

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    // one probe at a time
    if (this.probing) {
      throw new CircuitOpenError();
    }
    if (this.openedAt !== null) {
      if (Date.now() - this.openedAt < this.opts.holdMs) {
        throw new CircuitOpenError();
      }
      // half-open: set probing synchronously, before any await
      this.probing = true;
      this.consecutiveFailures = 0;
    }
    try {
      const result = await fn();
      this.probing = false;
      this.openedAt = null;
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      if (this.probing) {
        // probe failed: reopen
        this.openedAt = Date.now();
        this.probing = false;
      } else {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.opts.failureThreshold) {
          this.openedAt = Date.now();
        }
      }
      throw err;
    }
  }
}
