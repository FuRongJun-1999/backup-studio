import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { scanTree, type ScannedTree } from '../scan';
import { hashFile } from '../hash';
import type { AutoEvent, AutoPair, AutoRecycleEntry } from '../../../shared/aut-types';
import { checkRoot, exclusion, safePath, statMaybe } from './config';
import { copyAtomic, fault, stamp, type Gate } from './copy';
import { ensureRoom, moveToRecycle, recyclePath } from './recycle';
import type { WritePermit } from './permit';

interface IndexEntry { rel: string; source?: string; target: string; hash: string; restored?: boolean }
export interface SyncData {
  index: Record<string, IndexEntry>;
  recycle: AutoRecycleEntry[];
  publish?: { key: string; rel: string; source: string; hash: string };
}
export const keyFor = (rel: string) => Buffer.from(process.platform === 'win32' ? rel.toLowerCase() : rel).toString('base64url');
const token = (s: string) => createHash('sha256').update(s).digest('hex');
const pause = (message: string) => fault('CONFLICT', message);

async function snapshot(root: string, tree: ScannedTree) {
  const files = new Map<string, { rel: string; abs: string; stamp: string; size: number }>();
  const dirs = new Map(tree.dirs.map(rel => [keyFor(rel), rel]));
  if (dirs.size !== tree.dirs.length) throw pause('目录名称冲突');
  for (const [rel] of tree.files) {
    const abs = await safePath(root, rel);
    const s = await fs.lstat(abs);
    const key = keyFor(rel);
    if (!s.isFile() || s.isSymbolicLink() || files.has(key) || dirs.has(key)) throw pause('路径类型或名称冲突');
    files.set(key, { rel, abs, stamp: stamp(s), size: s.size });
  }
  return { files, dirs };
}
export async function reconcile(pair: AutoPair, data: SyncData, permit: WritePermit, gate: Gate, save: Gate, event: (a: AutoEvent['action'], d?: string) => void, syncing: () => void) {
  await checkRoot(pair.sourceRoot);
  await checkRoot(pair.targetRoot, constants.R_OK | constants.W_OK);
  const exclude = exclusion(pair);
  const [st, tt] = await Promise.all([scanTree(pair.sourceRoot, { exclude }), scanTree(pair.targetRoot, { exclude })]);
  if (st.errors.length || tt.errors.length) throw fault('SCAN_INCOMPLETE', '扫描不完整，已阻止同步');
  const [s, t] = await Promise.all([snapshot(pair.sourceRoot, st), snapshot(pair.targetRoot, tt)]);
  await gate();
  for (const row of data.recycle.filter(x => x.pending)) {
    const file = await statMaybe(await recyclePath(pair, row.id));
    const old = await statMaybe(await safePath(pair.targetRoot, row.relPath));
    if (file?.isFile() && file.size === row.size && (row.kind === 'replace' || !old)) {
      row.pending = false;
      if (row.kind === 'delete') delete data.index[keyFor(row.relPath)];
    } else if (!file && old?.isFile()) {
      if (row.kind === 'replace') {
        const partial = await safePath(pair.targetRoot, `.backup-studio/aut-recycle/${pair.id}/.aut-part-${row.id}`);
        const s = await statMaybe(partial);
        // The live original still exists; only discard an unfinished staging copy of it.
        if (s) {
          if (!s.isFile() || s.nlink !== 1) throw pause('回收临时文件类型异常');
          await gate(); await fs.unlink(partial);
        }
      }
      data.recycle.splice(data.recycle.indexOf(row), 1);
    } else throw pause('回收事务需要人工核对');
    await save();
  }
  if (data.publish) {
    const p = data.publish;
    const dest = t.files.get(p.key);
    if (dest && await hashFile(dest.abs) === p.hash) data.index[p.key] = { rel: dest.rel, source: p.source, target: dest.stamp, hash: p.hash };
    delete data.publish;
    await save();
  }
  const copies: { key: string; replace: boolean }[] = [];
  const deletes: string[] = [];
  for (const key of new Set([...s.files.keys(), ...t.files.keys(), ...Object.keys(data.index)])) {
    const src = s.files.get(key), dest = t.files.get(key), old = data.index[key];
    if (exclude(src?.rel ?? dest?.rel ?? old.rel)) continue;
    if ((src && t.dirs.has(key)) || (dest && s.dirs.has(key))) throw pause('源目录与备份目录的条目类型冲突');
    let external = Boolean(old ? !dest || dest.stamp !== old.target : dest);
    if (dest && external && old && await hashFile(dest.abs) === old.hash) {
      old.target = dest.stamp;
      external = false;
    }
    if (src && dest && (!old || external) && src.size === dest.size) {
      const [a, b] = await Promise.all([hashFile(src.abs), hashFile(dest.abs)]);
      if (a === b && stamp(await fs.lstat(src.abs)) === src.stamp && stamp(await fs.lstat(dest.abs)) === dest.stamp) {
        data.index[key] = { rel: dest.rel, source: src.stamp, target: dest.stamp, hash: a }; continue;
      }
    }
    if (external && (pair.externalChanges === 'pause' || (!src && !!dest))) throw pause('检测到备份目录外部修改，请核对后重新对账');
    if (external) event('外部修改已告警', '按已选覆盖策略处理');
    if (src && (!dest || src.stamp !== old?.source)) copies.push({ key, replace: !!dest });
    else if (src && external) copies.push({ key, replace: !!dest });
    else if (!src && dest && old && !old.restored && pair.syncDeletes) deletes.push(key);
  }
  if (deletes.length && (!s.files.size || deletes.length > Math.max(100, s.files.size) || deletes.length / Math.max(1, t.files.size) > 0.3 || st.skippedSymlinks > 0)) {
    throw fault('DELETE_RISK', '批量删除风险闸门已阻止操作；请保留备份并人工核对');
  }
  event('对账完成', `待复制 ${copies.length}，待回收 ${deletes.length}`);
  await save();
  syncing();
  for (const [key, rel] of s.dirs) {
    if (t.dirs.has(key)) continue;
    const dir = await safePath(pair.targetRoot, rel);
    await gate(); await fs.mkdir(dir, { recursive: true });
  }
  for (const { key, replace } of copies) {
    const src = s.files.get(key)!;
    const seen = t.files.get(key);
    const rel = seen?.rel ?? src.rel;
    const dest = await safePath(pair.targetRoot, rel);
    const parent = path.posix.dirname(rel);
    const partRel = `${parent === '.' ? '' : `${parent}/`}.aut-part-${token(pair.id + ':' + key)}`;
    const part = await safePath(pair.targetRoot, partRel);
    const verifyDest = async () => {
      const fresh = await statMaybe(await safePath(pair.targetRoot, rel));
      if ((fresh && stamp(fresh)) !== seen?.stamp) throw pause('备份文件在对账后被修改');
    };
    if (replace && seen) {
      await verifyDest();
      // Preserve the old live file until the verified replacement can be published atomically.
      await ensureRoom(pair, data.recycle, seen.size, permit, gate, save);
      const { randomUUID } = await import('node:crypto');
      const id = randomUUID(), at = Date.now();
      const oldCopy = await recyclePath(pair, id);
      const dir = path.dirname(oldCopy);
      await gate(); await fs.mkdir(dir, { recursive: true });
      const item: AutoRecycleEntry = { id, relPath: rel, size: seen.size, at, expiresAt: at + pair.retentionDays * 86_400_000, kind: 'replace', pending: true };
      data.recycle.push(item); await save();
      const oldPart = await safePath(pair.targetRoot, `.backup-studio/aut-recycle/${pair.id}/.aut-part-${id}`);
      await copyAtomic(dest, oldCopy, oldPart, 0, gate, verifyDest);
      item.pending = false; await save();
    }
    const hash = await copyAtomic(src.abs, dest, part, pair.stableMs, gate, async hash => {
      await verifyDest();
      if (stamp(await fs.lstat(src.abs)) !== src.stamp) throw fault('UNSTABLE', '源文件在对账后被修改');
      data.publish = { key, rel, source: src.stamp, hash };
      await save();
    });
    data.index[key] = { rel, source: src.stamp, target: stamp(await fs.lstat(dest)), hash };
    delete data.publish;
    event('已原子复制'); await save();
  }
  for (const key of deletes) {
    const item = t.files.get(key)!;
    if (await statMaybe(await safePath(pair.sourceRoot, data.index[key].rel))) throw fault('UNSTABLE', '删除前源条目重新出现');
    await moveToRecycle(pair, data.recycle, item.rel, 'delete', item.stamp, permit, gate, save);
    delete data.index[key];
    event('已移动到回收站'); await save();
  }
}
