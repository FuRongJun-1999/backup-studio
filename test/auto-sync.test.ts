import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { AutoSync, type WriteDecision, type WritePermit } from '../electron/engine/aut';
import { Debounce, retryDelay } from '../electron/engine/aut/queue';
import { ensureRoom, recyclePath } from '../electron/engine/aut/recycle';
import type { AutoPairInput, AutoRecycleEntry, AutoStatus } from '../shared/aut-types';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
async function fixture(options: Partial<AutoPairInput>, fn: (aut: AutoSync, input: AutoPairInput, decision: WriteDecision, local: string) => Promise<void>) {
  const base = await fs.mkdtemp(path.resolve('test', '.aut-fixture-'));
  const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target'), local = path.join(base, 'local');
  const decision: WriteDecision = { allowed: true, reachable: true, isolated: false, level: 'L0', volumeHealth: 'healthy', epoch: 'test-medium', evidence: [] };
  const aut = new AutoSync(local, { canWrite: () => decision });
  try { await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot); await fn(aut, { sourceRoot, targetRoot, stableMs: 500, ...options }, decision, local); }
  finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
}
async function until(aut: AutoSync, predicate: (s: AutoStatus) => boolean) {
  const deadline = Date.now() + 12_000;
  do { const s = await aut.status(); if (predicate(s)) return s; await wait(30); } while (Date.now() < deadline);
  throw new Error(`状态等待超时：${JSON.stringify(await aut.status())}`);
}
const put = (root: string, file: string, text: string) => fs.writeFile(path.join(root, file), text);
const get = (root: string, file: string) => fs.readFile(path.join(root, file), 'utf8');
async function enable(aut: AutoSync, input: AutoPairInput) { await aut.configure(input); await aut.start(); await aut.setEnabled(true); }
const idle = (aut: AutoSync) => until(aut, s => s.state === 'idle' && !!s.lastSync && s.pending === 0);

async function main() {
  await test('拒绝源内目标和反向包含', () => fixture({}, async (aut, input) => {
    const nested = path.join(input.sourceRoot, 'nested'); await fs.mkdir(nested);
    await assert.rejects(aut.configure({ ...input, targetRoot: nested }), /互相包含/);
    await assert.rejects(aut.configure({ sourceRoot: nested, targetRoot: input.sourceRoot }), /互相包含/);
  }));
  await test('开关持久化、关闭不再复制、开启后补账', () => fixture({}, async (aut, input, d, local) => {
    await enable(aut, input); await idle(aut); await aut.setEnabled(false);
    await put(input.sourceRoot, 'late', 'new'); await assert.rejects(get(input.targetRoot, 'late'), { code: 'ENOENT' });
    const next = new AutoSync(local, { canWrite: () => d });
    try { assert.equal((await next.status()).state, 'off'); await next.start(); await next.setEnabled(true); await idle(next); assert.equal(await get(input.targetRoot, 'late'), 'new'); }
    finally { await next.suspend(); }
  }));
  await test('对账新增、修改、排除与默认保留删除', () => fixture({}, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'new'); await put(input.sourceRoot, 'ignore.tmp', 'skip');
    await enable(aut, input); await idle(aut); assert.equal(await get(input.targetRoot, 'file'), 'new');
    await assert.rejects(get(input.targetRoot, 'ignore.tmp'), { code: 'ENOENT' });
    await put(input.sourceRoot, 'file', 'NEW'); await aut.resume(); await idle(aut);
    assert.equal(await get(input.targetRoot, 'file'), 'NEW');
    await fs.unlink(path.join(input.sourceRoot, 'file')); await aut.resume(); await idle(aut);
    assert.equal(await get(input.targetRoot, 'file'), 'NEW');
  }));
  await test('350ms 去抖机制合并批次', async () => {
    let count = 0; const debounce = new Debounce(() => count++, 30);
    debounce.push(); debounce.push(); debounce.push(); await wait(60); assert.equal(count, 1);
    debounce.push(); debounce.close(); await wait(60); assert.equal(count, 1);
  });
  await test('受管删除回收且七天内可恢复', () => fixture({ syncDeletes: true }, async (aut, input) => {
    for (const name of ['a', 'b', 'c', 'd']) await put(input.sourceRoot, name, name);
    await enable(aut, input); await idle(aut); await fs.unlink(path.join(input.sourceRoot, 'a'));
    await aut.resume(); const { recycle } = await idle(aut);
    assert.equal(recycle[0].expiresAt - recycle[0].at, 7 * 86_400_000);
    await assert.rejects(get(input.targetRoot, 'a'), { code: 'ENOENT' });
    await aut.setEnabled(false); await aut.restore(recycle[0].id); assert.equal(await get(input.targetRoot, 'a'), 'a');
    await assert.rejects(aut.restore(recycle[0].id), /未覆盖/);
  }));
  await test('容量只清理到期且经逐项授权的内容', () => fixture({ recycleMaxBytes: 4 }, async (aut, input, d) => {
    const pair = (await aut.configure(input)).pair!;
    const at = Date.now() - 8 * 86_400_000;
    const entry: AutoRecycleEntry = { id: 'c6b22936-f921-4f52-9aa4-ad8fef12bbaf', size: 4, at, expiresAt: at + 7 * 86_400_000, relPath: 'a', kind: 'delete' };
    const target = await recyclePath(pair, entry.id); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'data');
    const entries = [entry], permit: WritePermit = { canWrite: () => d }; const noop = async () => {};
    await assert.rejects(ensureRoom(pair, entries, 1, permit, noop, noop), { code: 'RECYCLE_FULL' });
    await assert.rejects(ensureRoom(pair, entries, 1, { ...permit, canPurge: () => true }, noop, noop, entry.expiresAt - 1), { code: 'RECYCLE_FULL' });
    await ensureRoom(pair, entries, 1, { ...permit, canPurge: () => true }, noop, noop);
    assert.equal(entries.length, 0); await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  }));
  await test('外部修改默认暂停，不覆盖', () => fixture({}, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'good'); await enable(aut, input); await idle(aut);
    await put(input.targetRoot, 'file', 'external'); await aut.resume();
    assert.match((await until(aut, s => s.state === 'paused')).reason!, /外部修改/);
    assert.equal(await get(input.targetRoot, 'file'), 'external');
  }));
  await test('复制前文件变化触发退避并最终重试', () => fixture({ stableMs: 1000 }, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'first'); await enable(aut, input);
    await until(aut, s => s.state === 'syncing'); await wait(250); await put(input.sourceRoot, 'file', 'next');
    const retry = await until(aut, s => s.attempts === 1); assert.equal(retry.pending, 1); assert.equal(retryDelay(2), 2000);
    await idle(aut); assert.equal(await get(input.targetRoot, 'file'), 'next');
  }));
  await test('L2 禁止写入，即使注入允许标记为真', () => fixture({}, async (aut, input, d) => {
    await put(input.sourceRoot, 'file', 'data'); await enable(aut, input); d.level = 'L2';
    await until(aut, s => s.block?.code === 'level2' && s.pending === 1);
    assert.deepEqual(await fs.readdir(input.targetRoot), []);
  }));
  await test('卷仍在线但需要修复，拒写并传递证据', () => fixture({}, async (aut, input, d) => {
    await aut.configure(input); d.volumeHealth = 'repair-required'; d.evidence = ['Full Repair Needed'];
    const s = await aut.status(); assert.equal(s.block?.code, 'repair-required'); assert.match(s.reason!, /需要修复/);
    assert.deepEqual(s.block?.evidence, d.evidence); await assert.rejects(aut.setEnabled(true));
    assert.deepEqual(await fs.readdir(input.targetRoot), []);
  }));
  console.log(`自动同步：${passed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
