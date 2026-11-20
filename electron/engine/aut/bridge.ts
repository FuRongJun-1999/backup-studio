import type { AutoPair, AutoRecycleEntry } from '../../../shared/aut-types';
import type { BackupService } from '../service';
import type { WriteDecision, WritePermit } from './permit';

export interface PermitOptions {
  /**
   * 闸门结论的复用时长（毫秒）。
   *
   * 只读检测需要拉起系统命令，逐次文件写入都查一遍会把 IO 打满；
   * 到期后重新检测，既能及时发现掉盘与卷状态变化，又不至于拖慢同步。
   */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 2000;

/**
 * 把容灾模块的写入闸门接到自动备份。
 *
 * 自动备份**不自行判定**介质是否可写：许可一律由容灾裁决，
 * 判定条件与手动备份完全一致（见 `BackupService.writeGate`）。
 */
export function createWritePermit(service: BackupService, options: PermitOptions = {}): WritePermit {
  const ttl = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
  const cache = new Map<string, { at: number; gate: Awaited<ReturnType<BackupService['writeGate']>> }>();

  const gate = async (root: string) => {
    const hit = cache.get(root);
    if (hit && Date.now() - hit.at < ttl) return hit.gate;
    const fresh = await service.writeGate(root);
    cache.set(root, { at: Date.now(), gate: fresh });
    return fresh;
  };

  return {
    async canWrite(pair: Readonly<AutoPair>): Promise<WriteDecision> {
      let g: Awaited<ReturnType<BackupService['writeGate']>>;
      try {
        g = await gate(pair.targetRoot);
      } catch (err) {
        return {
          allowed: false,
          reachable: false,
          isolated: false,
          level: 'unknown',
          volumeHealth: 'unknown',
          epoch: `unreachable:${Date.now()}`,
          reason: err instanceof Error ? err.message : '只读检测失败，已禁止写入',
          evidence: [],
        };
      }
      // epoch 只在闸门结论真正变化时改变，用于识别「介质或授权已变化」。
      const epoch = [g.level, g.reachable, g.isolated, g.volumeHealth, g.allowed].join('|');
      return { ...g, epoch };
    },

    /**
     * 回收站清理授权。
     *
     * 只有在**完整校验**证明当前备份集本身完好时，才允许清理回收项——
     * 否则删掉的可能是唯一一份可恢复内容。
     */
    async canPurge(pair: Readonly<AutoPair>, _entry: Readonly<AutoRecycleEntry>): Promise<boolean> {
      try {
        const g = await gate(pair.targetRoot);
        if (!g.allowed) return false;
        const full = await service.health(pair.targetRoot);
        return (
          full.index === '完整' &&
          full.files.mismatch === 0 &&
          full.files.truncated === 0 &&
          full.files.missing === 0 &&
          full.files.unchecked === 0
        );
      } catch {
        return false;
      }
    },
  };
}
