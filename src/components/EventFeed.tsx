import { useEffect, useRef } from 'react';
import { fmtClock } from '../lib/format';
import type { LogEntry } from '../../shared/types';

interface Props {
  logs: LogEntry[];
}

/**
 * 事件流。
 * 视口跟随规则：用户上翻阅读时冻结自动滚动，回到底部后恢复贴底跟随。
 */
export function EventFeed({ logs }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [logs]);

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = distanceFromBottom <= 40;
  };

  return (
    <div className="feed" ref={scrollerRef} onScroll={handleScroll}>
      {logs.length === 0 ? <div className="empty-hint">暂无事件</div> : null}
      {logs.map((entry) => (
        <div className="feed-row" key={entry.id} data-level={entry.level}>
          <span className="feed-time">{fmtClock(entry.ts)}</span>
          <span className="feed-text">{entry.text}</span>
        </div>
      ))}
    </div>
  );
}
