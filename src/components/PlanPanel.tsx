import { IconArrowUpRight, IconCopy, IconLayers, IconTrash } from './Icons';
import { FileName } from './FileName';
import { VirtualList } from './VirtualList';
import { fmtBytes, fmtInt } from '../lib/format';
import type { ActionType, PlanAction, SyncMode } from '../../shared/types';

interface Props {
  actions: PlanAction[];
  copy: number;
  update: number;
  rename: number;
  deleteCount: number;
  skip: number;
  totalFiles: number;
  bytes: number;
  syncMode: SyncMode;
  onSyncModeChange: (mode: SyncMode) => void;
}

const ROW_HEIGHT = 30;

const KIND_LABEL: Record<ActionType, string> = {
  copy: '新增',
  update: '更新',
  rename: '改名',
  delete: '删除',
  skip: '跳过',
};

function KindGlyph({ type }: { type: ActionType }) {
  if (type === 'copy') return <IconLayers size={12} className="icon-inline" />;
  if (type === 'rename') return <IconArrowUpRight size={12} className="icon-inline" />;
  if (type === 'delete') return <IconTrash size={12} className="icon-inline" />;
  if (type === 'update') return <IconCopy size={12} className="icon-inline" />;
  return null;
}

export function PlanPanel({
  actions,
  copy,
  update,
  rename,
  deleteCount,
  skip,
  totalFiles,
  bytes,
  syncMode,
  onSyncModeChange,
}: Props) {
  const visible = actions.filter((a) => a.type !== 'skip');

  return (
    <>
      <div className="section">
        <div className="section-title">备份计划</div>
        <div className="stat-row">
          <div className="stat">
            <span className="stat-value">{fmtInt(totalFiles)}</span>
            <span className="stat-label">源端文件</span>
          </div>
          <div className="stat">
            <span className="stat-value">{fmtInt(copy)}</span>
            <span className="stat-label">新增</span>
          </div>
          <div className="stat">
            <span className="stat-value">{fmtInt(update)}</span>
            <span className="stat-label">更新</span>
          </div>
          <div className="stat">
            <span className="stat-value">{fmtInt(rename)}</span>
            <span className="stat-label">改名</span>
          </div>
          <div className="stat">
            <span className="stat-value">{fmtInt(deleteCount)}</span>
            <span className="stat-label">删除</span>
          </div>
          <div className="stat">
            <span className="stat-value">{fmtInt(skip)}</span>
            <span className="stat-label">跳过</span>
          </div>
          <div className="stat">
            <span className="stat-value">{fmtBytes(bytes)}</span>
            <span className="stat-label">待传输</span>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">同步语义</div>
        <div className="segmented" role="group" aria-label="同步语义">
          <button
            type="button"
            aria-pressed={syncMode === 'mirror'}
            onClick={() => onSyncModeChange('mirror')}
          >
            严格镜像
          </button>
          <button
            type="button"
            aria-pressed={syncMode === 'mirror-archive'}
            onClick={() => onSyncModeChange('mirror-archive')}
          >
            镜像并保留历史
          </button>
        </div>
      </div>

      <div className="section" style={{ flex: '1 1 auto', minHeight: 0 }}>
        <div className="section-title">待处理文件</div>
        <div className="list-shell">
          <VirtualList
            items={visible}
            rowHeight={ROW_HEIGHT}
            rowClassName="action-row"
            emptyHint="尚未生成计划"
            renderRow={(action) => (
              <>
                <span className="action-kind">
                  <KindGlyph type={action.type} />
                  {KIND_LABEL[action.type]}
                </span>
                <FileName value={action.relPath} className="action-name" />
                <span className="action-size">{fmtBytes(action.size)}</span>
              </>
            )}
          />
        </div>
      </div>
    </>
  );
}
