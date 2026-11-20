import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props<T> {
  items: T[];
  rowHeight: number;
  rowClassName?: string;
  renderRow: (item: T, index: number) => ReactNode;
  overscan?: number;
  emptyHint?: string;
}

/**
 * 轻量虚拟列表。
 * 备份动辄十万级文件，全量渲染会把主线程打满；
 * 这里只渲染可视窗口 + 少量缓冲，保证滚动与进度更新同时流畅。
 */
export function VirtualList<T>({
  items,
  rowHeight,
  rowClassName,
  renderRow,
  overscan = 8,
  emptyHint,
}: Props<T>) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(480);
  const ticking = useRef(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => setViewport(el.clientHeight));
    observer.observe(el);
    setViewport(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const handleScroll = () => {
    if (ticking.current) return;
    ticking.current = true;
    requestAnimationFrame(() => {
      ticking.current = false;
      setScrollTop(scrollerRef.current?.scrollTop ?? 0);
    });
  };

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  const slice = items.slice(start, end);

  return (
    <div className="list-scroll" ref={scrollerRef} onScroll={handleScroll}>
      {items.length === 0 && emptyHint ? <div className="empty-hint">{emptyHint}</div> : null}
      <div className="list-canvas" style={{ height: items.length * rowHeight }}>
        {slice.map((item, index) => (
          <div
            key={start + index}
            className={rowClassName}
            style={{
              position: 'absolute',
              top: (start + index) * rowHeight,
              left: 0,
              right: 0,
              height: rowHeight,
            }}
          >
            {renderRow(item, start + index)}
          </div>
        ))}
      </div>
    </div>
  );
}
