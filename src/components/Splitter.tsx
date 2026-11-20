import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { animateSpring, SNAP_SPRING } from '../lib/spring';

const HANDLE = 10;
const MIN_RATIO = 0.24;
/**
 * 拖拽上限必须高于 COLLAPSE_RATIO，否则用户永远拖不到 82%，
 * 「左栏超过 82% 自动收起右栏」就成了不可达分支。
 */
const MAX_RATIO = 0.94;
/** 左栏超过 82% 自动收起右栏 */
const COLLAPSE_RATIO = 0.82;
const DEFAULT_RATIO = 0.56;

interface Props {
  containerRef: RefObject<HTMLDivElement>;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

/**
 * 可拖拽分栏。
 *
 * 交互契约：
 *  - 拖拽中：右侧预览盖透明遮罩，1:1 跟手，零延迟
 *  - 松手越过 82%：右栏自动收起，弹簧零回弹咬死
 *  - 拖拽中按 Esc：恢复拖拽前的比例
 *  - 双击手柄：回到 50/50
 */
export function Splitter({ containerRef, collapsed, onCollapsedChange }: Props) {
  const [dragging, setDragging] = useState(false);
  const ratioRef = useRef(DEFAULT_RATIO);
  const dragRef = useRef({ active: false, startX: 0, startRatio: DEFAULT_RATIO, prevRatio: DEFAULT_RATIO });
  const animRef = useRef<(() => void) | null>(null);
  const collapsedRef = useRef(collapsed);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  const applyRatio = useCallback(
    (ratio: number) => {
      const container = containerRef.current;
      if (!container) return;
      const total = Math.max(0, container.clientWidth - HANDLE);
      const left = Math.round(total * ratio);
      container.style.setProperty('--left-w', `${left}px`);
      container.style.setProperty('--right-w', `${Math.max(0, total - left)}px`);
    },
    [containerRef],
  );

  /** 弹簧吸附：零回弹，瞬间咬死 */
  const springTo = useCallback(
    (targetRatio: number) => {
      animRef.current?.();
      const from = ratioRef.current;
      animRef.current = animateSpring(
        0,
        1,
        SNAP_SPRING,
        (t) => {
          const ratio = from + (targetRatio - from) * t;
          ratioRef.current = ratio;
          applyRatio(ratio);
        },
        () => {
          animRef.current = null;
          ratioRef.current = targetRatio;
          applyRatio(targetRatio);
        },
      );
    },
    [applyRatio],
  );

  // 初始比例与窗口尺寸变化时保持比例
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    applyRatio(ratioRef.current);
    const observer = new ResizeObserver(() => {
      if (!dragRef.current.active) applyRatio(ratioRef.current);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyRatio, containerRef]);

  // 拖拽过程中的 Esc 复位
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragRef.current.active) return;
      event.preventDefault();
      const prev = dragRef.current.prevRatio;
      dragRef.current.active = false;
      containerRef.current?.classList.remove('is-resizing');
      document.body.style.cursor = '';
      setDragging(false);
      springTo(prev);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [containerRef, springTo]);

  // 指针抬起兜底：指针被移出窗口或捕获失效时，仍要正确结束拖拽态，
  // 否则分栏会永远停在「正在拖拽」状态，右侧遮罩撤不掉。
  useEffect(() => {
    const endDrag = () => {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      containerRef.current?.classList.remove('is-resizing');
      document.body.style.cursor = '';
      setDragging(false);
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('blur', endDrag);
    };
  }, [containerRef]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    event.preventDefault();
    animRef.current?.();
    animRef.current = null;

    const startRatio = collapsedRef.current ? 1 : ratioRef.current;

    dragRef.current = {
      active: true,
      startX: event.clientX,
      startRatio,
      prevRatio: startRatio,
    };

    // 指针捕获在部分环境下会抛 InvalidPointerId，不能让它中断后续状态设置
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败时退化为常规事件流，功能不受影响
    }
    container.classList.add('is-resizing');
    document.body.style.cursor = 'col-resize';
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag.active || !container) return;

    const total = Math.max(1, container.clientWidth - HANDLE);
    const ratio = drag.startRatio + (event.clientX - drag.startX) / total;
    // 收起态的起点是 1，上限必须保持 1，否则第一帧就被夹回 0.94 而跳变
    const upper = collapsedRef.current ? 1 : MAX_RATIO;
    const clamped = Math.max(MIN_RATIO, Math.min(upper, ratio));
    ratioRef.current = clamped;
    applyRatio(clamped);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag.active) return;

    drag.active = false;
    container?.classList.remove('is-resizing');
    document.body.style.cursor = '';
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针捕获可能已失效
    }

    const ratio = ratioRef.current;

    if (ratio >= COLLAPSE_RATIO) {
      springTo(1);
      if (!collapsedRef.current) onCollapsedChange(true);
      return;
    }
    if (collapsedRef.current) {
      onCollapsedChange(false);
      springTo(ratio);
      return;
    }
    // 常规松手：零延迟咬死在当前位置
    ratioRef.current = ratio;
    applyRatio(ratio);
  };

  const handleDoubleClick = () => {
    onCollapsedChange(false);
    springTo(0.5);
  };

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整分栏比例"
      data-dragging={dragging}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    >
      <span className="splitter-grip" />
    </div>
  );
}
