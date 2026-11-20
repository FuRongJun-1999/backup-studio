import { promises as fs } from 'node:fs';
import path from 'node:path';
import { META_DIR } from './scan';

export interface ManifestEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
  backedUpAt: number;
}

export interface Manifest {
  version: 1;
  sourceRoot: string;
  updatedAt: number;
  files: Record<string, ManifestEntry>;
}

export function metaDir(targetRoot: string): string {
  return path.join(targetRoot, META_DIR);
}

export function manifestPath(targetRoot: string): string {
  return path.join(metaDir(targetRoot), 'manifest.json');
}

export function partsDir(targetRoot: string): string {
  return path.join(metaDir(targetRoot), 'parts');
}

export function historyDir(targetRoot: string): string {
  return path.join(metaDir(targetRoot), 'history');
}

/**
 * 原子写入：先写临时文件再 rename。
 * 目标介质随时可能被拔出，半截 JSON 比没有 JSON 更糟。
 *
 * 移动介质上 rename 偶尔会因目标文件被短暂占用（索引器、杀软扫描）而失败，
 * 此时重试一次；仍失败则清理临时件，避免在介质上堆积垃圾。
 */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  options?: { createDirs?: boolean },
): Promise<void> {
  // createDirs: false —— 调用方确认父目录必须已存在时使用。
  // 介质掉线后创建目录会把已掉线的目标端「造回来」，掩盖掉线事实。
  if (options?.createDirs !== false) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(data, null, 2);
  const handle = await fs.open(tmp, 'w');
  let writeFailed = false;
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } catch (err) {
    // 写入阶段失败（介质掉线等）：临时件必须清理，不能在介质上留垃圾
    writeFailed = true;
    throw err;
  } finally {
    await handle.close();
    if (writeFailed) await fs.unlink(tmp).catch(() => undefined);
  }
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await fs.rename(tmp, filePath);
    } catch (retryErr) {
      await fs.unlink(tmp).catch(() => undefined);
      throw retryErr;
    }
  }
}

export async function readManifest(targetRoot: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(targetRoot), 'utf8');
    const parsed = JSON.parse(raw) as Manifest;
    if (!parsed || parsed.version !== 1 || typeof parsed.files !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeManifest(targetRoot: string, manifest: Manifest): Promise<void> {
  await writeJsonAtomic(manifestPath(targetRoot), manifest);
}
