export const DEBOUNCE_MS = 350;
export const MAX_ATTEMPTS = 5;
export interface QueueState { dirty: boolean; attempts: number; retryAt: number }
export function queueState(): QueueState { return { dirty: false, attempts: 0, retryAt: 0 }; }
export function retryDelay(attempt: number) { return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1)); }
export class Debounce {
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly callback: () => void, private readonly delay = DEBOUNCE_MS) {}
  push() { this.timer ??= setTimeout(() => { this.timer = undefined; this.callback(); }, this.delay); }
  close() { clearTimeout(this.timer); this.timer = undefined; }
}
