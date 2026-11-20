import { useEffect, useState, type FormEvent } from 'react';
import type { AutoStatus, AutoSyncApi } from '../../../shared/aut-types';
import './auto-sync.css';

const label: Record<AutoStatus['state'], string> = { off: '关闭', scanning: '开启：对账中', syncing: '开启：同步中', idle: '开启：空闲', waiting: '开启：等待介质', paused: '开启：暂停', error: '开启：错误' };
const time = (n?: number) => n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '尚无';
const gib = (n: number) => `${(n / 1024 ** 3).toLocaleString('zh-CN', { maximumFractionDigits: 3 })} GiB`;
export interface AutoSyncPanelProps { api: AutoSyncApi; sourceRoot?: string; targetRoot?: string }
export function AutoSyncPanel({ api, sourceRoot = '', targetRoot = '' }: AutoSyncPanelProps) {
  const [status, setStatus] = useState<AutoStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (busy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const value = await api.status(); if (!stopped) setStatus(value); }
      catch { if (!stopped) setError('无法读取自动备份状态'); }
      if (!stopped) timer = setTimeout(refresh, 1000);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, busy]);
  const perform = async (fn: () => Promise<AutoStatus>) => {
    setBusy(true); setError('');
    try { setStatus(await fn()); }
    catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const p = status?.pair;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (key: string) => String(data.get(key) ?? '');
    void perform(() => api.configure({
      sourceRoot: p?.sourceRoot ?? value('source'), targetRoot: p?.targetRoot ?? value('target'),
      excludes: value('excludes').split(/\r?\n/).map(x => x.trim()).filter(Boolean),
      syncDeletes: data.has('delete'), externalChanges: data.has('overwrite') ? 'overwrite' : 'pause',
      pollOnly: data.has('poll'), pollMs: Number(value('pollSeconds')) * 1000,
      allowSnapshotFiles: data.has('snapshots'), retentionDays: Number(value('days')),
      recycleMaxBytes: Number(value('capacity')) * 1024 ** 3, stableMs: p?.stableMs,
    }));
  };
  return <section className="aut-panel" aria-label="自动备份">
    <header className="aut-header">
      <div><h2>自动备份</h2><span aria-live="polite">{status ? label[status.state] : '读取状态中'}</span></div>
      <label className="aut-switch"><input type="checkbox" role="switch" checked={!!p?.enabled} disabled={busy || !p || (!p.enabled && !status?.available)} onChange={e => { const enabled = e.currentTarget.checked; void perform(() => api.setEnabled(enabled)); }} /><span>实时同步</span></label>
    </header>
    {status?.reason && <div className="aut-alert" role="alert">
      {status.reason}
      {status.block?.code === 'repair-required' && <p>请停止使用该卷，由人工在系统中核对并处理；处理后再重新对账。</p>}
      {!!status.block?.evidence?.length && <details><summary>查看只读检测证据</summary><ul>{status.block.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></details>}
    </div>}
    {error && <p className="aut-alert" role="alert">{error}</p>}
    {p?.enabled && status && ['waiting', 'paused', 'error'].includes(status.state) && <button type="button" disabled={busy || !status.available} onClick={() => void perform(() => api.resume())}>确认并重新对账</button>}
    <dl className="aut-route">
      <dt>源目录</dt><dd>{p?.sourceRoot || sourceRoot || '未选择'}</dd>
      <dt>备份目录</dt><dd>{p?.targetRoot || targetRoot || '未选择'}</dd>
    </dl>
    {status && <dl className="aut-meter">
      <div><dt>监听方式</dt><dd>{status.polling ? '轮询（非实时）' : '本地监听'}</dd></div>
      <div><dt>待处理批次</dt><dd>{status.pending} / 重试 {status.attempts}</dd></div>
      <div><dt>最后对账</dt><dd>{time(status.lastSync)}</dd></div>
      <div><dt>删除保护</dt><dd>{p?.syncDeletes ? `回收站，至少保留 ${p.retentionDays} 天` : '备份端保留'}</dd></div>
    </dl>}
    <details><summary>配对与排除规则</summary>
      <form key={p?.id ?? `${sourceRoot}|${targetRoot}`} onSubmit={submit}>
        <fieldset disabled={busy || !!p?.enabled}>
          {!p && <><label>源目录<input name="source" required defaultValue={sourceRoot} /></label><label>备份目录<input name="target" required defaultValue={targetRoot} /></label></>}
          <label>附加排除规则（每行一条，可用 *）<textarea name="excludes" defaultValue={p?.excludes.join('\n')} rows={3} /></label>
          <label><input type="checkbox" name="delete" defaultChecked={p?.syncDeletes} />启用删除同步（只移入回收站）</label>
          <label><input type="checkbox" name="overwrite" defaultChecked={p?.externalChanges === 'overwrite'} />外部修改时保留旧版再覆盖</label>
          <label><input type="checkbox" name="snapshots" defaultChecked={p?.allowSnapshotFiles} />包含离线数据库或虚拟机快照文件</label>
          <label><input type="checkbox" name="poll" defaultChecked={p?.pollOnly} />仅轮询（网络盘或云盘）</label>
          <div className="aut-fields"><label>轮询秒数<input name="pollSeconds" type="number" min="5" max="300" step="0.001" required defaultValue={(p?.pollMs ?? 30000) / 1000} /></label>
          <label>最少保留天数<input name="days" type="number" min="7" max="3650" required defaultValue={p?.retentionDays ?? 7} /></label>
          <label>上限（GiB）<input name="capacity" type="number" min="0.000000001" step="any" required defaultValue={(p?.recycleMaxBytes ?? 10 * 1024 ** 3) / 1024 ** 3} /></label></div>
          <button type="submit">保存配对设置</button>
        </fieldset>
      </form>
    </details>
    <details><summary>回收站：{status?.recycle.length ?? 0} 项，占用 {gib(status?.recycleBytes ?? 0)}</summary>
      {!status?.recycle.length ? <p>暂无回收项</p> : <ul>{status.recycle.map(r => <li className="aut-entry" key={r.id}><span>{r.relPath}<small>{r.kind === 'delete' ? '已回收' : '替换前版本'} / 至少保留至 {time(r.expiresAt)}</small></span><button type="button" disabled={busy || !status.available || !!status.block || r.pending} onClick={() => void perform(() => api.restore(r.id))}>恢复到备份目录</button></li>)}</ul>}
    </details>
    <details><summary>最近同步事件</summary>
      {!status?.recent.length ? <p>暂无事件</p> : <ul>{status.recent.slice(0, 20).map((a, i) => <li className="aut-entry" key={`${a.at}-${i}`}><span>{a.action}{a.detail && <small>{a.detail}</small>}</span><time>{time(a.at)}</time></li>)}</ul>}
    </details>
  </section>;
}
