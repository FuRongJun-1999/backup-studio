import { IconAlert, IconPause, IconPlay } from './Icons';
import { fmtBytes, fmtDuration, fmtInt, fmtPercent, fmtThroughput } from '../lib/format';
import type { BackupPhase, MediaAssessment, MediaState, QuarantineMark } from '../../shared/types';

interface Props {
  phase: BackupPhase;
  media: MediaState;
  totalFiles: number;
  copy: number;
  update: number;
  rename: number;
  deleteCount: number;
  bytes: number;
  copiedBytes: number;
  elapsedMs: number;
  throughput: number;
  etaMs: number;
  activeFile?: string;
  assessment: MediaAssessment | null;
  quarantine: QuarantineMark | null;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRecover: () => void;
  onReleaseQuarantine: () => void;
}

const RUNNING: BackupPhase[] = ['running', 'paused'];

export function ProgressPanel({
  phase,
  media,
  totalFiles,
  copy,
  update,
  rename,
  deleteCount,
  bytes,
  copiedBytes,
  elapsedMs,
  throughput,
  etaMs,
  activeFile,
  assessment,
  quarantine,
  onPause,
  onResume,
  onCancel,
  onRecover,
  onReleaseQuarantine,
}: Props) {
  const ratio = bytes > 0 ? copiedBytes / bytes : 0;
  const running = RUNNING.includes(phase);
  const finished = phase === 'completed';
  const quarantined = Boolean(quarantine && !quarantine.released);

  return (
    <>
      <div className="progress-head">
        <div>
          <div className="progress-figure">
            <span>{finished ? '100' : fmtPercent(ratio).replace('%', '')}</span>
            <span className="progress-unit">%</span>
          </div>
        </div>
        <div className="action-bar-group">
          {running ? (
            <button className="btn btn-sm" type="button" onClick={phase === 'paused' ? onResume : onPause}>
              {phase === 'paused' ? <IconPlay size={13} className="icon-inline" /> : <IconPause size={13} className="icon-inline" />}
              {phase === 'paused' ? '继续' : '暂停'}
            </button>
          ) : null}
          {running ? (
            <button className="btn btn-sm" type="button" onClick={onCancel}>
              取消
            </button>
          ) : null}
          {phase === 'interrupted' ? (
            <button className="btn btn-sm btn-primary" type="button" onClick={onRecover}>
              恢复备份
            </button>
          ) : null}
        </div>
      </div>

      <div className="progress-track">
        <div
          className="progress-fill"
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
          data-indeterminate={phase === 'running' && bytes === 0}
        />
      </div>

      <div className="metric-grid">
        <div className="metric">
          <span className="metric-value">{fmtInt(totalFiles)}</span>
          <span className="metric-label">文件总数</span>
        </div>
        <div className="metric">
          <span className="metric-value">
            {fmtInt(copy + update + rename)}
          </span>
          <span className="metric-label">需写入</span>
        </div>
        <div className="metric">
          <span className="metric-value">{fmtInt(deleteCount)}</span>
          <span className="metric-label">待删除</span>
        </div>
        <div className="metric">
          <span className="metric-value">{fmtBytes(copiedBytes)}</span>
          <span className="metric-label">已传输</span>
        </div>
        <div className="metric">
          <span className="metric-value">{fmtThroughput(throughput)}</span>
          <span className="metric-label">写入速度</span>
        </div>
        <div className="metric">
          <span className="metric-value">{fmtDuration(elapsedMs)}</span>
          <span className="metric-label">已用时</span>
        </div>
        <div className="metric">
          <span className="metric-value">{etaMs > 0 ? fmtDuration(etaMs) : '—'}</span>
          <span className="metric-label">预计剩余</span>
        </div>
      </div>

      {media === 'lost' ? (
        <div className="banner" data-tone="danger">
          <span className="banner-dot" />
          <span>备份介质已断开，已停止写入。断点保存在本机，重新接入后需确认恢复</span>
        </div>
      ) : null}

      {media === 'restoring' ? (
        <div className="banner">
          <span className="banner-dot" />
          <span>正在等待备份介质重新接入</span>
        </div>
      ) : null}

      {quarantined ? (
        <div className="banner" data-tone="danger">
          <IconAlert size={13} className="icon-inline" />
          <span>该介质已标记为隔离观察：{quarantine?.reason}。这不是物理坏盘结论</span>
          <span style={{ flex: '1 1 auto' }} />
          <button className="btn btn-sm" type="button" onClick={onReleaseQuarantine}>
            解除隔离
          </button>
        </div>
      ) : null}

      {phase === 'interrupted' ? (
        <div className="banner" data-tone="warn">
          <IconAlert size={13} className="icon-inline" />
          <span>备份已中断。恢复前会重新扫描并生成新计划，旧的删除动作不会执行</span>
        </div>
      ) : null}

      {assessment ? (
        <div className="banner">
          <span className="banner-dot" />
          <span>
            介质判定 {assessment.level}（置信度 {Math.round(assessment.confidence * 100)}%）：{assessment.suggestion}
          </span>
        </div>
      ) : null}

      {activeFile ? (
        <div className="banner">
          <IconAlert size={13} className="icon-inline" />
          <span className="status-line-text">正在写入 {activeFile}</span>
        </div>
      ) : null}
    </>
  );
}
