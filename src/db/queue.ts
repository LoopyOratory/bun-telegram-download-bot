import { logger } from "../utils/logger";

type WriteFn<T = unknown> = () => T;

/**
 * Serial write queue for SQLite.
 *
 * SQLite allows only one writer at a time. All database writes
 * go through this queue to ensure serialised access.
 */
class WriteQueue {
  private queue: WriteFn[] = [];
  private processing = false;

  enqueue<T>(fn: WriteFn<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(() => {
        try {
          resolve(fn());
        } catch (err) {
          reject(err);
        }
      });
      if (!this.processing) this.process();
    });
  }

  private process(): void {
    this.processing = true;
    while (this.queue.length > 0) {
      const fn = this.queue.shift()!;
      fn();
    }
    this.processing = false;
  }

  get queueDepth(): number {
    return this.queue.length;
  }
}

export const writeQueue = new WriteQueue();

/**
 * Helper: run a synchronous write through the queue.
 */
export function queuedWrite<T>(fn: () => T): Promise<T> {
  return writeQueue.enqueue(fn);
}
