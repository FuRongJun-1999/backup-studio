import { IconDrive, IconFolder } from './Icons';
import { fmtBytes, fmtInt } from '../lib/format';
import type { ScanResult } from '../../shared/types';

interface Props {
  sourceRoot: string;
  targetRoot: string;
  scan: ScanResult | null;
  busy: boolean;
  onSourceChange: (value: string) => void;
  onTargetChange: (value: string) => void;
  onBrowseSource: () => void;
  onBrowseTarget: () => void;
  onCommit: () => void;
}

function Meta({ files, bytes }: { files: number; bytes: number }) {
  return (
    <div className="path-meta">
      <span>
        <span className="num">{fmtInt(files)}</span> 个文件
      </span>
      <span className="meta-sep" aria-hidden="true" />
      <span className="num">{fmtBytes(bytes)}</span>
    </div>
  );
}

export function DirectoryPicker({
  sourceRoot,
  targetRoot,
  scan,
  busy,
  onSourceChange,
  onTargetChange,
  onBrowseSource,
  onBrowseTarget,
  onCommit,
}: Props) {
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
      onCommit();
    }
  };

  return (
    <div className="path-grid">
      <div className="path-field-row">
        <span className="path-icon">
          <IconFolder size={15} />
        </span>
        <input
          className="path-field"
          value={sourceRoot}
          spellCheck={false}
          placeholder="选择需要备份的源目录"
          onChange={(e) => onSourceChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={commitOnEnter}
        />
        <button className="btn btn-sm" type="button" onClick={onBrowseSource} disabled={busy}>
          浏览
        </button>
      </div>
      {scan ? <Meta files={scan.sourceFiles} bytes={scan.sourceBytes} /> : null}

      <div className="path-field-row">
        <span className="path-icon">
          <IconDrive size={15} />
        </span>
        <input
          className="path-field"
          value={targetRoot}
          spellCheck={false}
          placeholder="选择备份存放的目标目录"
          onChange={(e) => onTargetChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={commitOnEnter}
        />
        <button className="btn btn-sm" type="button" onClick={onBrowseTarget} disabled={busy}>
          浏览
        </button>
      </div>
      {scan ? <Meta files={scan.targetFiles} bytes={scan.targetBytes} /> : null}
    </div>
  );
}
