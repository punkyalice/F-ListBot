import { MessageTooLongError } from "../util/errors";

export interface FloodLimits {
  /** Minimum ms between MSG or PRI sends - they share one bucket per spec ("PRI has the same flood control as MSG"). */
  msgIntervalMs: number;
  /** Minimum ms between LRP sends - a separate, much looser bucket. */
  lrpIntervalMs: number;
  chatMaxBytes: number;
  privMaxBytes: number;
  lfrpMaxBytes: number;
  /**
   * Minimum ms between any other outbound command (JCH, LCH, PRO, KIN, ...). The protocol
   * docs don't define an explicit flood error for these, but F-List's bot/client rules
   * impose a general "do not spam API requests (1/s max)" requirement covering all of
   * them - this bucket is the safety net for that, independent of any VAR the server sends.
   */
  otherIntervalMs: number;
}

const DEFAULT_LIMITS: FloodLimits = {
  msgIntervalMs: 1100, // spec: >=1/sec for MSG; small safety margin over the hard 1000ms
  lrpIntervalMs: 610_000, // spec: >=1/10min for LRP; safety margin over 600_000ms
  chatMaxBytes: 4096,
  privMaxBytes: 50_000,
  lfrpMaxBytes: 50_000,
  otherIntervalMs: 1100, // F-List bot rule: max 1 API request/sec; small safety margin
};

type BucketKey = "message" | "lrp" | "other"; // "message" covers both MSG and PRI

interface QueueItem {
  send: () => void;
  resolve: () => void;
}

/**
 * Per-command-class rate limiter honoring both F-Chat's documented flood control (MSG,
 * PRI, LRP) and F-List's general bot/client rule that ALL outbound API requests must stay
 * at 1/s or slower ("other" bucket - JCH, LCH, PRO, KIN, and anything else that isn't
 * chat/PM/ad text). Buckets are seeded with safe defaults (usable before the server's
 * first VAR batch arrives) and kept up to date by updateLimits() on every subsequent VAR
 * event for the lifetime of the connection - never cached once and forgotten.
 */
export class OutgoingQueue {
  #limits: FloodLimits = { ...DEFAULT_LIMITS };
  #queues: Record<BucketKey, QueueItem[]> = { message: [], lrp: [], other: [] };
  #lastSentAt: Record<BucketKey, number> = { message: 0, lrp: 0, other: 0 };
  #timers: Record<BucketKey, NodeJS.Timeout | undefined> = { message: undefined, lrp: undefined, other: undefined };

  updateLimits(partial: Partial<FloodLimits>): void {
    this.#limits = { ...this.#limits, ...partial };
  }

  getLimits(): FloodLimits {
    return { ...this.#limits };
  }

  /**
   * Enqueues a rate-limited send. `bucket` selects which flood-control bucket applies;
   * `maxBytes`, if given, is checked up front so callers get an immediate, precise
   * rejection instead of waiting on the queue only to have the server bounce it with ERR 15.
   */
  enqueue(bucket: BucketKey, payloadForSizeCheck: string | undefined, maxBytes: number | undefined, send: () => void): Promise<void> {
    if (payloadForSizeCheck !== undefined && maxBytes !== undefined) {
      const byteLength = Buffer.byteLength(payloadForSizeCheck, "utf-8");
      if (byteLength > maxBytes) {
        return Promise.reject(new MessageTooLongError(maxBytes));
      }
    }

    return new Promise((resolve) => {
      this.#queues[bucket].push({ send, resolve });
      this.#drain(bucket);
    });
  }

  /** Convenience wrapper for the "other" bucket (JCH/LCH/PRO/KIN/...) - no payload size check, since these aren't user-composed text. */
  enqueueOther(send: () => void): Promise<void> {
    return this.enqueue("other", undefined, undefined, send);
  }

  #intervalFor(bucket: BucketKey): number {
    if (bucket === "message") return this.#limits.msgIntervalMs;
    if (bucket === "lrp") return this.#limits.lrpIntervalMs;
    return this.#limits.otherIntervalMs;
  }

  #drain(bucket: BucketKey): void {
    if (this.#timers[bucket] !== undefined) return; // a drain is already scheduled
    const queue = this.#queues[bucket];
    if (queue.length === 0) return;

    const intervalMs = this.#intervalFor(bucket);
    const elapsed = Date.now() - this.#lastSentAt[bucket];
    const wait = Math.max(0, intervalMs - elapsed);

    this.#timers[bucket] = setTimeout(() => {
      this.#timers[bucket] = undefined;
      const item = this.#queues[bucket].shift();
      if (item) {
        this.#lastSentAt[bucket] = Date.now();
        item.send();
        item.resolve();
      }
      this.#drain(bucket);
    }, wait);
  }
}
