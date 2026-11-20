import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { hashFile } from '../hash';
import { statMaybe } from './config';

export type Gate = () => Promise<void>;
export function fault(code: string, message: string) { return Object.assign(new Error(message), { code }); }
export const stamp = (s: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }) => `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}:${s.dev}`;
export async function copyAtomic(src: string, dest: string, temporary: string, stableMs: number, gate: Gate, beforeCommit: (verifiedHash: string) => Promise<void>, noReplace = false) {
  const initial = await fs.lstat(src);
  if (!initial.isFile() || initial.isSymbolicLink()) throw fault('CONFLICT', '源文件类型已变更');
  if (stableMs) await wait(stableMs);
  if (stamp(initial) !== stamp(await fs.lstat(src))) throw fault('UNSTABLE', '文件仍在写入');
  const input = await fs.open(src, 'r');
  let result: string;
  try {
    if (stamp(await input.stat()) !== stamp(initial)) throw fault('UNSTABLE', '源文件已变更');
    const before = await statMaybe(temporary);
    if (before && (!before.isFile() || before.nlink !== 1)) throw fault('CONFLICT', '临时文件类型异常');
    await gate();
    const output = await fs.open(temporary, before ? 'r+' : 'wx+');
    try {
      if (before && stamp(before) !== stamp(await output.stat())) throw fault('CONFLICT', '临时文件已被替换');
      const bytes = Buffer.alloc(1 << 20);
      const existing = Buffer.alloc(bytes.length);
      const hash = createHash('sha256');
      for (let offset = 0; offset < initial.size;) {
        const size = Math.min(bytes.length, initial.size - offset);
        const { bytesRead } = await input.read(bytes, 0, size, offset);
        if (bytesRead !== size) throw fault('UNSTABLE', '读取期间源文件缩短');
        const chunk = bytes.subarray(0, size);
        hash.update(chunk);
        const previous = await output.read(existing, 0, size, offset);
        if (previous.bytesRead !== size || !existing.subarray(0, size).equals(chunk)) {
          let n = 0;
          while (n < size) {
            await gate();
            const { bytesWritten } = await output.write(chunk, n, size - n, offset + n);
            if (!bytesWritten) throw fault('EIO', '临时文件写入失败');
            n += bytesWritten;
          }
        }
        offset += size;
      }
      if ((await output.stat()).size !== initial.size) { await gate(); await output.truncate(initial.size); }
      await gate(); await output.utimes(initial.atime, initial.mtime);
      await gate(); await output.sync();
      result = hash.digest('hex');
    } finally { await output.close(); }
    if (await hashFile(temporary) !== result) throw fault('VERIFY_FAILED', '临时文件回读校验失败');
    await beforeCommit(result);
    if (stamp(await input.stat()) !== stamp(initial) || stamp(await fs.lstat(src)) !== stamp(initial)) throw fault('UNSTABLE', '复制期间源文件已变更');
    if (noReplace) {
      await gate(); await fs.link(temporary, dest);
      await gate(); await fs.unlink(temporary);
    } else { await gate(); await fs.rename(temporary, dest); }
    // Windows does not expose directory fsync through Node. The file itself is synced before rename.
    if (process.platform !== 'win32') {
      const dir = await fs.open(path.dirname(dest), 'r');
      try { await gate(); await dir.sync(); } finally { await dir.close(); }
    }
    return result;
  } finally { await input.close(); }
}
