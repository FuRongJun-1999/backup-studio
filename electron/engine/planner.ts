import os from 'node:os';
import path from 'node:path';
import { hashFiles } from './hash';
import type { ScannedFile, ScannedTree } from './scan';
import type { Manifest } from './manifest';
import type { PlanAction, SyncMode } from '../../shared/types';

export interface PlanInput {
  sourceRoot: string;
  targetRoot: string;
  source: ScannedTree;
  target: ScannedTree;
  manifest: Manifest | null;
  syncMode: SyncMode;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface PlanResult {
  actions: PlanAction[];
  summary: {
    totalFiles: number;
    copy: number;
    update: number;
    rename: number;
    delete: number;
    skip: number;
    bytes: number;
  };
  requiresConfirmation: boolean;
  confirmReason: string;
}

/** 计划列表上限，避免十万级文件把 IPC 通道打爆 */
const MAX_ACTIONS = 20000;

function hashConcurrency(): number {
  return Math.max(2, Math.min(8, os.cpus().length - 1));
}

/**
 * 生成备份计划。
 *
 * 判定顺序（成本从低到高）：
 *  1. 元数据快判：manifest 记录的大小与 mtime 完全一致 → 跳过，零 I/O
 *  2. 大小不同 → 必然内容不同 → 直接覆盖，不做无意义哈希
 *  3. 大小相同但 mtime 不同 → 哈希比对，确认是否真的变了
 *  4. 源端新增文件 → 先按 size 分桶，只有可能与孤儿文件配对的才计算哈希
 *     命中同哈希即判定为「改名」，整个文件无需重新拷贝
 */
export async function buildPlan(input: PlanInput): Promise<PlanResult> {
  const { sourceRoot, targetRoot, source, target, manifest, syncMode } = input;
  const report = input.onProgress ?? (() => {});
  const manifestFiles = manifest?.files ?? {};

  const srcFiles = source.files;
  const dstFiles = target.files;

  // 目标端存在、源端已消失的文件
  const orphans: ScannedFile[] = [];
  for (const dst of dstFiles.values()) {
    if (!srcFiles.has(dst.relPath)) orphans.push(dst);
  }

  const actions: PlanAction[] = [];
  const identical: PlanAction[] = [];
  const newFiles: ScannedFile[] = [];
  const sameSize: { src: ScannedFile; dst: ScannedFile }[] = [];
  const sizeChanged: { src: ScannedFile; dst: ScannedFile }[] = [];

  // ---- 第一轮：零 I/O 的元数据快判 ----
  report('分类', 0, srcFiles.size);
  for (const src of srcFiles.values()) {
    const dst = dstFiles.get(src.relPath);
    if (!dst) {
      newFiles.push(src);
      continue;
    }
    const memo = manifestFiles[src.relPath];
    if (memo && memo.size === src.size && memo.mtimeMs === src.mtimeMs) {
      identical.push({
        id: `skip:${src.relPath}`,
        type: 'skip',
        relPath: src.relPath,
        size: src.size,
        status: 'skipped',
        note: '与上次备份完全一致',
      });
      continue;
    }
    if (src.size !== dst.size) {
      sizeChanged.push({ src, dst });
      continue;
    }
    sameSize.push({ src, dst });
  }

  // ---- 第二轮：确定真正需要计算哈希的集合 ----
  // 只有「源端新增」的文件可能与孤儿文件构成改名关系。
  // 按 size 分桶后，没有同尺寸孤儿的文件直接判为新增拷贝，省掉一次全量哈希。
  const orphanBySize = new Map<number, ScannedFile[]>();
  for (const orphan of orphans) {
    const bucket = orphanBySize.get(orphan.size);
    if (bucket) bucket.push(orphan);
    else orphanBySize.set(orphan.size, [orphan]);
  }

  const newFilesToHash = newFiles.filter((f) => orphanBySize.has(f.size));
  const neededSizes = new Set(newFilesToHash.map((f) => f.size));

  // 孤儿文件哈希：优先用 manifest 里的历史值，其次才实算
  const orphanHashEntries: { key: string; path: string }[] = [];
  for (const orphan of orphans) {
    if (!neededSizes.has(orphan.size)) continue;
    const memo = manifestFiles[orphan.relPath];
    if (memo && memo.size === orphan.size && memo.sha256) continue; // manifest 已有，无需实算
    orphanHashEntries.push({
      key: orphan.relPath,
      path: path.join(targetRoot, orphan.relPath),
    });
  }

  // ---- 第三轮：并发计算哈希 ----
  report('计算哈希', 0, orphanHashEntries.length + newFilesToHash.length + sameSize.length);

  const orphanHashes = await hashFiles(
    orphanHashEntries,
    hashConcurrency(),
    (done, total) => report('计算哈希', done, total),
  );
  // 用 manifest 里的历史哈希补齐
  for (const orphan of orphans) {
    if (orphanHashes.has(orphan.relPath)) continue;
    const memo = manifestFiles[orphan.relPath];
    if (memo && memo.size === orphan.size && memo.sha256) {
      orphanHashes.set(orphan.relPath, memo.sha256);
    }
  }

  const sourceHashes = await hashFiles(
    newFilesToHash.map((f) => ({ key: f.relPath, path: path.join(sourceRoot, f.relPath) })),
    hashConcurrency(),
    (done, total) => report('计算哈希', done, total),
  );

  const sameSizeHashEntries = sameSize.map(({ src, dst }) => {
    const memo = manifestFiles[src.relPath];
    if (memo && memo.size === dst.size && memo.sha256) return null;
    return { key: src.relPath, path: path.join(sourceRoot, src.relPath) };
  });
  const sameSizeHashes = await hashFiles(
    sameSizeHashEntries.filter((e): e is { key: string; path: string } => e !== null),
    hashConcurrency(),
    (done, total) => report('计算哈希', done, total),
  );
  // manifest 里的历史哈希优先
  for (const { src, dst } of sameSize) {
    if (sameSizeHashes.has(src.relPath)) continue;
    const memo = manifestFiles[src.relPath];
    if (memo && memo.size === dst.size && memo.sha256) {
      sameSizeHashes.set(src.relPath, memo.sha256);
    }
  }

  // ---- 第四轮：目标端哈希（用于同尺寸疑似变更的判定） ----
  const dstHashEntries = sameSize
    .filter(({ src, dst }) => {
      const memo = manifestFiles[src.relPath];
      if (memo && memo.size === dst.size && memo.sha256) return false;
      return !sameSizeHashes.has(src.relPath);
    })
    .map(({ dst }) => ({ key: dst.relPath, path: path.join(targetRoot, dst.relPath) }));
  const dstHashes = await hashFiles(dstHashEntries, hashConcurrency(), (done, total) =>
    report('计算哈希', done, total),
  );
  for (const { src, dst } of sameSize) {
    if (dstHashes.has(dst.relPath)) continue;
    const memo = manifestFiles[src.relPath];
    if (memo && memo.size === dst.size && memo.sha256) {
      dstHashes.set(dst.relPath, memo.sha256);
    }
  }

  // ---- 第五轮：改名配对 ----
  const orphanByHash = new Map<string, ScannedFile[]>();
  for (const orphan of orphans) {
    const hash = orphanHashes.get(orphan.relPath);
    if (!hash) continue;
    const bucket = orphanByHash.get(hash);
    if (bucket) bucket.push(orphan);
    else orphanByHash.set(hash, [orphan]);
  }

  const consumedOrphans = new Set<string>();
  const renameByNewPath = new Map<string, ScannedFile>();

  // ---- 第六轮：落地动作 ----
  let copy = 0;
  let update = 0;
  let rename = 0;
  let bytes = 0;

  for (const src of newFiles) {
    const hash = sourceHashes.get(src.relPath);
    if (hash) {
      const candidates = orphanByHash.get(hash) ?? [];
      // 同名优先：更符合用户心智（a.txt → b/a.txt）
      const sameName = candidates.find((o) => path.basename(o.relPath) === path.basename(src.relPath));
      const chosen = sameName ?? candidates.find((o) => !consumedOrphans.has(o.relPath));
      if (chosen) {
        consumedOrphans.add(chosen.relPath);
        renameByNewPath.set(src.relPath, chosen);
        rename++;
        actions.push({
          id: `rename:${src.relPath}`,
          type: 'rename',
          relPath: src.relPath,
          fromRelPath: chosen.relPath,
          dstPath: src.relPath,
          size: src.size,
          status: 'pending',
          note: `由 ${chosen.relPath} 改名，内容一致，无需复制`,
        });
        continue;
      }
    }
    copy++;
    bytes += src.size;
    actions.push({
      id: `copy:${src.relPath}`,
      type: 'copy',
      relPath: src.relPath,
      srcPath: path.join(sourceRoot, src.relPath),
      dstPath: path.join(targetRoot, src.relPath),
      size: src.size,
      status: 'pending',
      note: '源端新增',
    });
  }

  for (const { src, dst } of sameSize) {
    const srcHash = sameSizeHashes.get(src.relPath);
    const dstHash = dstHashes.get(dst.relPath);
    if (srcHash && dstHash && srcHash === dstHash) {
      identical.push({
        id: `skip:${src.relPath}`,
        type: 'skip',
        relPath: src.relPath,
        size: src.size,
        status: 'skipped',
        note: '内容一致，仅修改时间',
      });
      continue;
    }
    update++;
    bytes += src.size;
    actions.push({
      id: `update:${src.relPath}`,
      type: 'update',
      relPath: src.relPath,
      srcPath: path.join(sourceRoot, src.relPath),
      dstPath: path.join(targetRoot, src.relPath),
      size: src.size,
      status: 'pending',
      note: '内容已变更',
    });
  }

  for (const { src, dst } of sizeChanged) {
    update++;
    bytes += src.size;
    actions.push({
      id: `update:${src.relPath}`,
      type: 'update',
      relPath: src.relPath,
      srcPath: path.join(sourceRoot, src.relPath),
      dstPath: path.join(targetRoot, src.relPath),
      size: src.size,
      status: 'pending',
      note: `大小由 ${dst.size} 变为 ${src.size}`,
    });
  }

  let deleted = 0;
  for (const orphan of orphans) {
    if (consumedOrphans.has(orphan.relPath)) continue;
    deleted++;
    actions.push({
      id: `delete:${orphan.relPath}`,
      type: 'delete',
      relPath: orphan.relPath,
      dstPath: path.join(targetRoot, orphan.relPath),
      size: orphan.size,
      status: 'pending',
      note: syncMode === 'mirror-archive' ? '源端已不存在，归档至历史目录' : '源端已不存在',
    });
  }

  const skip = identical.length;
  const important = actions.filter((a) => a.type !== 'skip');
  const ordered = [...important, ...identical].slice(0, MAX_ACTIONS);

  // ---- 删除风险闸门 ----
  // 目标端文件远多于源端，通常意味着选错了源目录或目标目录。
  // 这种情况下静默删除会造成不可逆的数据损失，必须让用户明确确认。
  const orphanRatio = dstFiles.size === 0 ? 0 : deleted / dstFiles.size;
  const requiresConfirmation =
    deleted > 0 && (srcFiles.size === 0 || orphanRatio > 0.3 || deleted > Math.max(100, srcFiles.size));

  const confirmReason = requiresConfirmation
    ? `目标端有 ${deleted} 个文件在源端已不存在（占目标端 ${Math.round(orphanRatio * 100)}%）。${
        syncMode === 'mirror-archive' ? '这些文件会被归档到历史目录，不会立即消失。' : '这些文件将被删除。'
      }`
    : '';

  return {
    actions: ordered,
    summary: {
      totalFiles: srcFiles.size,
      copy,
      update,
      rename,
      delete: deleted,
      skip,
      bytes,
    },
    requiresConfirmation,
    confirmReason,
  };
}
