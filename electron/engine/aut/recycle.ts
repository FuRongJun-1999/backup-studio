import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AutoPair, AutoRecycleEntry } from '../../../shared/aut-types';
import { safePath, statMaybe } from './config';
import { fault, stamp, type Gate } from './copy';
import type { WritePermit } from './permit';

export const recycleBytes = (entries: AutoRecycleEntry[]) => entries.reduce((n, entry) => n + entry.size, 0);
export function recyclePath(pair: AutoPair, id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('无效回收项');
  return safePath(pair.targetRoot, `.backup-studio/aut-recycle/${pair.id}/${id}`);
}
export async function ensureRoom(pair: AutoPair, entries: AutoRecycleEntry[], size: number, permit: WritePermit, gate: Gate, save: Gate, now = Date.now()) {
  if (size > pair.recycleMaxBytes) throw fault('RECYCLE_FULL', '单文件超过回收站上限，原文件保留');
  for (const item of [...entries].sort((a, b) => a.expiresAt - b.expiresAt)) {
    if (recycleBytes(entries) + size <= pair.recycleMaxBytes) break;
    if (item.pending || now < Math.max(item.expiresAt, item.at + pair.retentionDays * 86_400_000) || await permit.canPurge?.(pair, item) !== true) continue;
    const file = await recyclePath(pair, item.id);
    const s = await statMaybe(file);
    if (s && (!s.isFile() || s.size !== item.size)) throw fault('CONFLICT', '回收项遭外部修改');
    if (s) { await gate(); await fs.unlink(file); }
    entries.splice(entries.indexOf(item), 1);
    await save();
  }
  if (recycleBytes(entries) + size > pair.recycleMaxBytes) throw fault('RECYCLE_FULL', '回收站容量不足；未授权清理的副本已保留');
}
export async function moveToRecycle(pair: AutoPair, entries: AutoRecycleEntry[], relPath: string, kind: AutoRecycleEntry['kind'], expected: string, permit: WritePermit, gate: Gate, save: Gate) {
  const origin = await safePath(pair.targetRoot, relPath);
  const original = await fs.lstat(origin);
  if (!original.isFile() || stamp(original) !== expected) throw fault('CONFLICT', '备份文件已变更');
  await ensureRoom(pair, entries, original.size, permit, gate, save);
  const id = randomUUID();
  const dest = await recyclePath(pair, id);
  const dir = await safePath(pair.targetRoot, `.backup-studio/aut-recycle/${pair.id}`);
  await gate(); await fs.mkdir(dir, { recursive: true });
  const at = Date.now();
  const item = { id, relPath, size: original.size, at, expiresAt: at + pair.retentionDays * 86_400_000, kind, pending: true };
  entries.push(item);
  await save();
  if (stamp(await fs.lstat(origin)) !== expected) throw fault('CONFLICT', '备份文件已变更');
  await gate(); await fs.rename(origin, dest);
  item.pending = false;
}
