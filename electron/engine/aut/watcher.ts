import { watch, type FSWatcher } from 'node:fs';
import type { AutoPair } from '../../../shared/aut-types';
import { exclusion } from './config';
import { Debounce } from './queue';

export function watchPair(pair: AutoPair, enqueue: () => void, degraded: () => void) {
  const batch = new Debounce(enqueue);
  const exclude = exclusion(pair);
  const watchers: FSWatcher[] = [];
  const dirty = () => batch.push();
  const fallback = () => { for (const watcher of watchers.splice(0)) watcher.close(); degraded(); dirty(); };
  if (!pair.pollOnly) {
    try {
      // Only source events trigger rapid checks; target drift is detected during reconciliation.
      const watcher = watch(pair.sourceRoot, { recursive: true }, (_event, name) => {
        if (!name || !exclude(name.replace(/\\/g, '/'))) dirty();
      });
      watchers.push(watcher);
      watcher.on('error', fallback);
    } catch { fallback(); }
  }
  return () => { batch.close(); for (const watcher of watchers.splice(0)) watcher.close(); };
}
