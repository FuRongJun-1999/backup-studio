export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass?: number;
}

/**
 * 阻尼弹簧积分器。
 *
 * 用半隐式欧拉推进，帧间做子步进，保证高刚度下数值稳定。
 * 参数语义与主流动效库的 spring 一致：
 *  - stiffness 1200 / damping 80  → 过阻尼 ζ≈1.15，零回弹，松手瞬间咬死
 *  - stiffness 380  / damping 18  → 欠阻尼 ζ≈0.46，末端轻微回弹
 */
export function animateSpring(
  from: number,
  to: number,
  config: SpringConfig,
  onFrame: (value: number) => void,
  onDone?: () => void,
): () => void {
  const { stiffness, damping, mass = 1 } = config;
  let value = from;
  let velocity = 0;
  let cancelled = false;
  let last = performance.now();
  let raf = 0;

  const step = (now: number): void => {
    if (cancelled) return;
    // 切后台再回来时 dt 会异常大，钳制后拆成子步进，避免炸开
    const dt = Math.min((now - last) / 1000, 0.048);
    last = now;

    const steps = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      const force = -stiffness * (value - to) - damping * velocity;
      velocity += (force / mass) * h;
      value += velocity * h;
    }

    onFrame(value);

    if (Math.abs(value - to) < 0.0004 && Math.abs(velocity) < 0.004) {
      onFrame(to);
      onDone?.();
      return;
    }
    raf = requestAnimationFrame(step);
  };

  raf = requestAnimationFrame(step);

  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
  };
}

/** 拖拽吸附：零延迟咬死，不允许过冲 */
export const SNAP_SPRING: SpringConfig = { stiffness: 1200, damping: 80 };

/** 操作反馈：轻微 Q 弹 */
export const POP_SPRING: SpringConfig = { stiffness: 380, damping: 18 };
