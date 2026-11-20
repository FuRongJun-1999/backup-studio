import type {
  AppState,
  LogEntry,
  MediaState,
  PlanAction,
  ScanResult,
  SyncMode,
} from '../../shared/types';
import type { AutoPair, AutoStatus } from '../../shared/aut-types';
import type { BackupAPI, PlanPayload, ProgressPayload, StartOptions } from './api';

type Handler<T> = (payload: T) => void;

function makeHandlers<T>() {
  const handlers: Handler<T>[] = [];
  return {
    push: (handler: Handler<T>) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    emit: (payload: T) => handlers.forEach((h) => h(payload)),
  };
}

/**
 * 浏览器预览用的模拟后端。
 * 仅在脱离 Electron 渲染层时启用（window.backupAPI 不存在），
 * 用于在普通浏览器里核对界面布局与动效，不参与真实备份。
 */
export function createMockApi(): BackupAPI {
  let seq = 0;
  const logs = makeHandlers<LogEntry>();
  const progress = makeHandlers<ProgressPayload>();
  const action = makeHandlers<PlanAction>();
  const plan = makeHandlers<PlanPayload>();
  const state = makeHandlers<AppState>();
  const media = makeHandlers<MediaState>();

  const baseState = (): AppState => ({
    phase: 'idle',
    media: 'online',
    syncMode: 'mirror',
    sourceRoot: '',
    targetRoot: '',
    jobId: null,
    summary: {
      totalFiles: 0,
      copy: 0,
      update: 0,
      rename: 0,
      delete: 0,
      skip: 0,
      bytes: 0,
      copiedBytes: 0,
      elapsedMs: 0,
      throughput: 0,
      etaMs: 0,
      media: 'online',
      phase: 'idle',
    },
    actions: [],
    logs: [],
    requiresConfirmation: false,
    confirmReason: '',
    recoverableJob: null,
    assessment: null,
    quarantine: null,
  });

  let current = baseState();
  let timer: number | null = null;

  // 自动备份的浏览器演示状态：不触碰真实文件系统。
  let autoPair: AutoPair | null = null;
  let autoEnabled = false;
  const autoStatus = (): AutoStatus => ({
    pair: autoPair,
    state: autoEnabled ? 'idle' : 'off',
    available: autoPair !== null,
    polling: autoPair?.pollOnly ?? false,
    pending: 0,
    attempts: 0,
    reason: autoPair ? '浏览器演示：未连接真实文件系统，不进行实际同步' : undefined,
    recent: [],
    recycle: [],
    recycleBytes: 0,
  });

  const pushLog = (level: LogEntry['level'], text: string) => {
    seq += 1;
    const entry: LogEntry = { id: seq, ts: Date.now(), level, text };
    current = { ...current, logs: [...current.logs, entry] };
    logs.emit(entry);
  };

  const fakeActions = (): PlanAction[] => {
    const names = [
      'documents/2024年度总结报告.docx',
      'documents/合同/供应商合作协议-2025-签署版.pdf',
      'media/photos/IMAG20240712094530.jpg',
      'media/videos/产品发布会回放.mp4',
      'projects/atlas/src/services/backup-engine/worker-pool.ts',
      'projects/atlas/src/services/backup-engine/chunk-copier.ts',
      'projects/atlas/docs/architecture/backup-protocol.md',
      'archives/legacy/系统迁移方案-归档版本.zip',
      'assets/icons/app-store/1024x1024@2x.png',
      'notes/会议纪要/2025-03-18 周会同步.md',
      'projects/atlas/services/backup-engine/增量同步模块/worker-pool-implementation-2025-final.ts',
      'media/raw-captures/2024年度发布会现场录制原片未压缩母版文件.mov',
    ];
    const types: PlanAction['type'][] = ['copy', 'copy', 'copy', 'update', 'copy', 'rename', 'skip', 'delete'];
    return Array.from({ length: 48 }, (_, i) => {
      const relPath = names[i % names.length];
      const type = types[i % types.length];
      return {
        id: `${type}:${relPath}:${i}`,
        type,
        relPath,
        size: (i + 1) * 1024 * 37,
        status: 'pending',
        note: type === 'rename' ? '由 documents/旧版方案.docx 改名，内容一致，无需复制' : undefined,
      } as PlanAction;
    });
  };

  return {
    async pickDirectory(title: string) {
      return title.includes('源') ? 'D:\\资料库\\主目录' : 'E:\\备份仓\\每日快照';
    },

    async scan(sourceRoot: string, targetRoot: string): Promise<ScanResult> {
      await new Promise((r) => setTimeout(r, 260));
      return {
        sourceRoot,
        targetRoot,
        sourceFiles: 12480,
        sourceBytes: 8_912_345_678,
        sourceDirs: 812,
        targetFiles: 11902,
        targetBytes: 8_204_112_233,
        durationMs: 412,
        errors: [],
      };
    },

    async plan(sourceRoot: string, targetRoot: string, syncMode: SyncMode): Promise<PlanPayload> {
      await new Promise((r) => setTimeout(r, 220));
      const actions = fakeActions();
      const summary = {
        totalFiles: 12480,
        copy: 218,
        update: 46,
        rename: 12,
        delete: 37,
        skip: 12167,
        bytes: 3_204_112_233,
        copiedBytes: 0,
        elapsedMs: 0,
        throughput: 0,
        etaMs: 0,
        media: 'online' as MediaState,
        phase: 'ready' as AppState['phase'],
      };
      const payload: PlanPayload = {
        actions,
        summary,
        requiresConfirmation: false,
        confirmReason: '',
      };
      current = { ...current, sourceRoot, targetRoot, syncMode, actions, summary };
      plan.emit(payload);
      return payload;
    },

    async start(options: StartOptions): Promise<AppState> {
      const payload = await this.plan(options.sourceRoot, options.targetRoot, options.syncMode);
      current = { ...current, phase: 'running', summary: { ...payload.summary, phase: 'running' } };
      state.emit(current);
      pushLog('success', '开始备份');

      let copied = 0;
      const total = payload.summary.bytes;
      const startedAt = Date.now();
      timer = window.setInterval(() => {
        copied += Math.round(total / 90);
        const elapsed = Date.now() - startedAt;
        const throughput = (copied / elapsed) * 1000;
        const next: ProgressPayload = {
          copiedBytes: Math.min(copied, total),
          bytes: total,
          activeFile: 'projects/atlas/src/services/backup-engine/chunk-copier.ts',
          throughput,
          etaMs: Math.round(((total - copied) / Math.max(1, throughput)) * 1000),
        };
        progress.emit(next);
        if (copied >= total) {
          if (timer) window.clearInterval(timer);
          timer = null;
          current = { ...current, phase: 'completed' };
          state.emit(current);
          pushLog('success', '备份完成');
        }
      }, 90);
      return current;
    },

    async pause() {
      current = { ...current, phase: 'paused' };
      state.emit(current);
      pushLog('info', '任务已暂停');
      return current;
    },

    async resume() {
      current = { ...current, phase: 'running' };
      state.emit(current);
      pushLog('info', '任务已继续');
      return current;
    },

    async cancel() {
      if (timer) window.clearInterval(timer);
      timer = null;
      current = { ...current, phase: 'cancelled' };
      state.emit(current);
      pushLog('warn', '备份已取消');
      return current;
    },

    async getState() {
      return current;
    },

    async cleanupMeta() {
      return current;
    },

    async health() {
      return { assessment: { level: 'L1', confidence: 0.95, writable: false, at: Date.now(), suggestion: '演示卷需人工检查，保持只读。', evidence: [{ kind: '演示卷', detail: 'NTFS / Full Repair Needed / 脏位置位', at: Date.now() }] }, condition: 'filesystem-repair', permission: true, volume: 'X:', smart: '能力缺失', index: '未验证', files: { complete: 0, truncated: 0, missing: 0, mismatch: 0, unchecked: 0 } };
    },
    async reenumerate(root) { return this.health(root); },
    async repairDryRun(_root, request) {
      if (request.volume !== 'X:' || !request.confirmed || !request.confirmedAgain || !request.disclaimerAccepted) throw new Error('须选择作用卷并完成两次确认');
      return { mode: 'dry-run', auditId: 'demo', volume: 'X:', imageCreated: false, guidance: '浏览器演示：未创建镜像或调用修复。' };
    },
    async exportPartitionEvidence() { return { auditId: 'demo', guidance: '浏览器演示：未写入文件。' }; },
    async capabilities() { return (await import('../../electron/engine/capability')).capabilityMatrix; },

    async assess(_targetRoot: string) {
      return {
        assessment: {
          level: 'L0' as const,
          confidence: 0.8,
          evidence: [],
          suggestion: '介质读取稳定',
          at: Date.now(),
          writable: true,
        },
        state: current,
      };
    },

    async recover() {
      current = { ...current, phase: 'running' };
      state.emit(current);
      return current;
    },

    async quarantine() {
      return current;
    },

    async releaseQuarantine() {
      return current;
    },

    async reveal() {},

    async setTheme(mode) {
      return mode === 'light' ? 'light' : 'dark';
    },

    autoSync: {
      async status() {
        return autoStatus();
      },
      async configure(input) {
        autoPair = {
          id: 'demo-pair',
          enabled: false,
          sourceRoot: input.sourceRoot,
          targetRoot: input.targetRoot,
          excludes: input.excludes ?? [],
          syncDeletes: input.syncDeletes ?? false,
          retentionDays: input.retentionDays ?? 7,
          recycleMaxBytes: input.recycleMaxBytes ?? 10 * 1024 ** 3,
          externalChanges: input.externalChanges ?? 'pause',
          pollOnly: input.pollOnly ?? false,
          pollMs: input.pollMs ?? 30000,
          stableMs: input.stableMs ?? 750,
          allowSnapshotFiles: input.allowSnapshotFiles ?? false,
        };
        autoEnabled = false;
        return autoStatus();
      },
      async setEnabled(enabled) {
        if (enabled) autoEnabled = true;
        else autoEnabled = false;
        return autoStatus();
      },
      async resume() {
        return autoStatus();
      },
      async restore() {
        return autoStatus();
      },
    },

    onState: (cb) => state.push(cb),
    onPlan: (cb) => plan.push(cb),
    onProgress: (cb) => progress.push(cb),
    onAction: (cb) => action.push(cb),
    onLog: (cb) => logs.push(cb),
    onMedia: (cb) => media.push(cb),
  };
}
