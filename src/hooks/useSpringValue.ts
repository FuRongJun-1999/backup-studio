import { useCallback, useRef, useState } from 'react';
import { animateSpring, type SpringConfig } from '../lib/spring';

/** 返回一个可被弹簧驱动的数值 */
export function useSpringValue(config: SpringConfig) {
  const [value, setValue] = useState(0);
  const cancelRef = useRef<(() => void) | null>(null);

  const animate = useCallback(
    (from: number, to: number, onDone?: () => void) => {
      cancelRef.current?.();
      cancelRef.current = animateSpring(from, to, config, setValue, onDone);
    },
    [config],
  );

  return { value, animate };
}
