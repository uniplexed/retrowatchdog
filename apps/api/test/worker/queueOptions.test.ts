import { describe, expect, it } from "vitest";
import { defaultJobOptions } from "../../src/worker/queueOptions.js";

describe("worker Queue defaultJobOptions", () => {
  // Boot catch-up (index.ts) reuses fixed jobIds across runs
  // (catalog-sync-unit.<source>.<unit>, tracked-refresh.<source>). BullMQ 6
  // dedups adds by jobId regardless of the existing job's status, so a
  // completed/failed job that isn't evicted permanently blocks all future
  // catch-up enqueues under that id. This must stay true or boot catch-up
  // silently stops working after the first run.
  it("evicts completed and failed jobs so dedup jobIds are released", () => {
    expect(defaultJobOptions?.removeOnComplete).toBe(true);
    expect(defaultJobOptions?.removeOnFail).toBe(true);
  });
});
