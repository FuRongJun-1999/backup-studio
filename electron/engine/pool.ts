import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CopyResult, CopyTask, WorkerRequest, WorkerResponse } from './copyWorker';

export type { CopyResult } from './copyWorker';

export interface PoolCallbacks {
  onProgress?: (id: string, copiedBytes: number, totalBytes: number) => void;
  onDone?: (result: CopyResult) => void;
  onError?: (id: string, error: { message: string; code?: string }) => void;
}

interface Pending {
  task: CopyTask;
  callbacks: PoolCallbacks;
}

interface Slot {
  index: number;
  worker: Worker;
  busy: boolean;
  current: Pending | null;
}

/**
 * worker_threads 复制池。
 *
 * 每个线程独立发起 read/write 系统调用，由内核页缓存与调度器并行处理，
 * 真正打满磁盘队列；主线程只做派发与状态汇总，不参与任何字节搬运。
 */
export class CopyPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private paused = false;
  private destroyed = false;

  constructor(
    workerPath: string,
    size: number,
    private readonly defaults: PoolCallbacks = {},
  ) {
    for (let index = 0; index < size; index += 1) {
      const worker = new Worker(workerPath);
      const slot: Slot = { index, worker, busy: false, current: null };
      worker.on('message', (message: WorkerResponse) => this.onWorkerMessage(slot, message));
      worker.on('error', (err) => {
        const pending = slot.current;
        slot.current = null;
        slot.busy = false;
        const report = pending?.callbacks ?? this.defaults;
        report.onError?.(pending?.task.id ?? '', { message: err.message, code: 'WORKER_CRASH' });
        this.pump();
      });
      // 注意：此处不可 unref。
      // unref 后工作线程不再持有事件循环，纯脚本场景（引擎验证、CLI 化）
      // 会在任务未完成时直接静默退出。改为由 destroy() 显式终止线程。
      this.slots.push(slot);
    }
  }

  submit(task: CopyTask, callbacks: PoolCallbacks): void {
    this.queue.push({ task, callbacks });
    this.pump();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.pump();
  }

  /** 介质恢复后重新派发被中断的任务 */
  requeue(task: CopyTask, callbacks: PoolCallbacks): void {
    this.submit(task, callbacks);
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.slots.filter((s) => s.busy).length;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await Promise.all(
      this.slots.map(async (slot) => {
        try {
          await slot.worker.terminate();
        } catch {
          // 线程可能已退出
        }
      }),
    );
  }

  private pump(): void {
    if (this.destroyed || this.paused) return;
    for (const slot of this.slots) {
      if (slot.busy) continue;
      const pending = this.queue.shift();
      if (!pending) return;
      slot.busy = true;
      slot.current = pending;
      const request: WorkerRequest = { type: 'copy', task: pending.task };
      slot.worker.postMessage(request);
    }
  }

  private onWorkerMessage(slot: Slot, message: WorkerResponse): void {
    if (!slot.current) return;
    const pending = slot.current;

    switch (message.type) {
      case 'progress':
        pending.callbacks.onProgress?.(message.id, message.copiedBytes, message.totalBytes);
        break;
      case 'done':
        slot.current = null;
        slot.busy = false;
        pending.callbacks.onDone?.(message);
        this.pump();
        break;
      case 'error':
        slot.current = null;
        slot.busy = false;
        pending.callbacks.onError?.(message.id, { message: message.message, code: message.code });
        this.pump();
        break;
      default:
        break;
    }
  }
}

export function defaultWorkerPath(): string {
  return path.join(__dirname, 'copyWorker.js');
}
