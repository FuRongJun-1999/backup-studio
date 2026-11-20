import type { AutoBlock, AutoPair, AutoRecycleEntry } from '../../../shared/aut-types';
import type { WriteGate } from '../../../shared/types';

export interface WriteDecision extends WriteGate {
  /** Changes on media/authorization change, not on every query. */
  epoch: string;
}
export interface WritePermit {
  canWrite(pair: Readonly<AutoPair>): WriteDecision | Promise<WriteDecision>;
  /** Only return true when another verified complete recovery point survives this purge. */
  canPurge?(pair: Readonly<AutoPair>, entry: Readonly<AutoRecycleEntry>): boolean | Promise<boolean>;
}
export class Blocked extends Error {
  constructor(readonly block: AutoBlock) { super(block.reason); }
}
export function denial(d: WriteDecision): AutoBlock | undefined {
  const make = (code: AutoBlock['code'], reason: string): AutoBlock => ({ code, reason, evidence: d.evidence });
  if (d.volumeHealth === 'repair-required') return make('repair-required', `卷需要修复，已禁止写入${d.reason ? `：${d.reason}` : ''}`);
  if (d.isolated !== false) return make('isolated', d.reason || '介质已隔离，禁止写入');
  if (d.reachable !== true) return make('offline', d.reason || '备份介质不可达');
  if (d.level === 'L2') return make('level2', d.reason || '容灾判定为 L2，禁止写入');
  if (d.volumeHealth !== 'healthy') return make('health-unknown', d.reason || '未能确认卷健康，禁止写入');
  if (d.allowed !== true || (d.level !== 'L0' && d.level !== 'L1') || !d.epoch) return make('denied', d.reason || '容灾模块未授权写入');
}
