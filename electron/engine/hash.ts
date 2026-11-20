import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * 统一使用 SHA-256。
 * node:crypto 的摘要计算是原生实现（C++），不在 JS 线程瓶颈上，
 * 大文件哈希与复制流可以零拷贝并行。
 */
export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath, { highWaterMark: 1024 * 1024 }), hash);
  return hash.digest('hex');
}

/** 计算一批文件的哈希，带并发上限，避免把磁盘打满成随机寻道。 */
export async function hashFiles(
  entries: { key: string; path: string }[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (entries.length === 0) return result;

  let cursor = 0;
  let done = 0;
  const workerCount = Math.max(1, Math.min(concurrency, entries.length));

  const runOne = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      const entry = entries[index];
      try {
        result.set(entry.key, await hashFile(entry.path));
      } catch {
        // 读不到的文件留给后续复制阶段报错，不在此处中断整轮规划
      }
      done++;
      onProgress?.(done, entries.length);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
  return result;
}
