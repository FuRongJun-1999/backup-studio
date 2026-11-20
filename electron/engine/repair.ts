import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from './manifest';
import type { HealthReport, RepairRequest, RepairResult } from '../../shared/types';

/** 不接收命令执行器：确认后的唯一操作是镜像和写入本机审计。 */
export async function rehearseRepair(request: RepairRequest, preflight: () => Promise<HealthReport>, image: (letter: string) => Promise<Buffer>, localDir: string): Promise<RepairResult> {
  if (!request || typeof request.volume !== 'string' || !/^[A-Z]:$/.test(request.volume) || request.confirmed !== true || request.confirmedAgain !== true || request.disclaimerAccepted !== true) {
    throw new Error('须明确选择作用卷、完成两次确认并接受免责提示');
  }
  const report = await preflight();
  if (!report.permission) throw new Error('无管理员或 root 权限：仅能查看或导出证据');
  if (report.volume !== request.volume || report.assessment.level !== 'L1' || report.condition !== 'filesystem-repair') throw new Error('作用卷或只读预检不符合人工修复演练条件');
  const auditId = randomUUID();
  const dir = path.join(localDir, auditId);
  const audit = { mode: 'dry-run', volume: request.volume, at: Date.now(), confirmed: true, confirmedAgain: true, disclaimerAccepted: true, command: null };
  await writeJsonAtomic(path.join(dir, 'request.json'), audit);
  try {
    const bytes = await image(request.volume[0]);
    if (!bytes.length) throw new Error('无镜像数据');
    const imageName = 'volume-edge-sectors.json';
    await writeJsonAtomic(path.join(dir, imageName), { volume: request.volume, format: 'first-and-last-sector-base64', byteLength: bytes.length, data: bytes.toString('base64') });
    await writeJsonAtomic(path.join(dir, 'result.json'), { ...audit, imagePath: imageName, status: 'image-created-no-command' });
  } catch {
    await writeJsonAtomic(path.join(dir, 'result.json'), { ...audit, imagePath: null, status: 'failed-no-command' });
    throw new Error('修复演练未完成：镜像或审计失败；未调用系统修复');
  }
  return { mode: 'dry-run', auditId, volume: request.volume, imageCreated: true, guidance: '本机已保存作用卷首尾关键扇区，只完成演练。请先备份同卷数据，再由管理员决定是否在应用之外人工处理。' };
}
