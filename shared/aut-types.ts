export interface AutoPairInput {
  sourceRoot: string;
  targetRoot: string;
  excludes?: string[];
  syncDeletes?: boolean;
  retentionDays?: number;
  recycleMaxBytes?: number;
  externalChanges?: 'pause' | 'overwrite';
  pollOnly?: boolean;
  pollMs?: number;
  stableMs?: number;
  allowSnapshotFiles?: boolean;
}

export interface AutoPair extends Required<AutoPairInput> { id: string; enabled: boolean }
export type AutoRunState = 'off' | 'scanning' | 'syncing' | 'idle' | 'waiting' | 'paused' | 'error';
export type AutoBlockCode = 'offline' | 'isolated' | 'level2' | 'repair-required' | 'health-unknown' | 'denied';
export interface AutoBlock { code: AutoBlockCode; reason: string; evidence?: readonly string[] }
export interface AutoEvent { at: number; action: string; detail?: string }
export interface AutoRecycleEntry {
  id: string;
  relPath: string;
  size: number;
  at: number;
  expiresAt: number;
  kind: 'delete' | 'replace';
  pending?: boolean;
}
export interface AutoStatus {
  pair: AutoPair | null;
  state: AutoRunState;
  available: boolean;
  polling: boolean;
  pending: number;
  attempts: number;
  reason?: string;
  block?: AutoBlock;
  lastSync?: number;
  recent: AutoEvent[];
  recycle: AutoRecycleEntry[];
  recycleBytes: number;
}
export interface AutoSyncApi {
  status(): Promise<AutoStatus>;
  configure(pair: AutoPairInput): Promise<AutoStatus>;
  setEnabled(enabled: boolean): Promise<AutoStatus>;
  resume(): Promise<AutoStatus>;
  restore(id: string): Promise<AutoStatus>;
}
