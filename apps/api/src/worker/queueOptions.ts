import type { QueueOptions } from "bullmq";

// Boot catch-up reuses fixed jobIds for dedup, and BullMQ silently skips an
// add whose jobId exists in ANY state. Evicting finished jobs frees the id, or
// every later catch-up for it would be a silent no-op.
export const defaultJobOptions: QueueOptions["defaultJobOptions"] = {
  removeOnComplete: true,
  removeOnFail: true,
};
