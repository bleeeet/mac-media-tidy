import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runPlan } from '../lib/runner.js';

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
}

function dupPlan(root, keepPath, dupPath) {
  return {
    root,
    dupGroups: [{
      hash: 'h', size: 4,
      keep: { path: keepPath, rel: 'a.jpg', size: 4, mtime: 1, ext: 'jpg' },
      remove: [{ path: dupPath, rel: 'b.jpg', size: 4, mtime: 2, ext: 'jpg' }],
    }],
    imageTasks: [],
    videoTasks: [],
  };
}

test('runPlan 把重复文件移入 _trash', async () => {
  const root = await tmpRoot();
  const keep = path.join(root, 'a.jpg');
  const dup = path.join(root, 'b.jpg');
  await fs.writeFile(keep, 'same');
  await fs.writeFile(dup, 'same');

  const report = await runPlan(dupPlan(root, keep, dup), { dedup: true }, () => {});

  await fs.access(keep);
  await assert.rejects(fs.access(dup));
  await fs.access(path.join(root, '_trash', 'b.jpg'));
  assert.equal(report.savedBytes, 4);
  await fs.rm(root, { recursive: true });
});

test('runPlan 在关闭去重时不动任何文件', async () => {
  const root = await tmpRoot();
  const keep = path.join(root, 'a.jpg');
  const dup = path.join(root, 'b.jpg');
  await fs.writeFile(keep, 'same');
  await fs.writeFile(dup, 'same');

  await runPlan(dupPlan(root, keep, dup), { dedup: false }, () => {});
  await fs.access(dup);
  await fs.rm(root, { recursive: true });
});

test('runPlan 发出 phase 与 done 事件', async () => {
  const root = await tmpRoot();
  const events = [];
  const plan = { root, dupGroups: [], imageTasks: [], videoTasks: [] };
  await runPlan(plan, { dedup: true }, (e) => events.push(e));

  assert.ok(events.some((e) => e.type === 'done'));
  await fs.rm(root, { recursive: true });
});

test('runPlan 为每个处理过的文件发出 item 事件', async () => {
  const root = await tmpRoot();
  const keep = path.join(root, 'a.jpg');
  const dup = path.join(root, 'b.jpg');
  await fs.writeFile(keep, 'same');
  await fs.writeFile(dup, 'same');

  const events = [];
  await runPlan(dupPlan(root, keep, dup), { dedup: true }, (e) => events.push(e));

  const items = events.filter((e) => e.type === 'item');
  assert.equal(items.length, 1);
  assert.equal(items[0].action, 'dedup-removed');
  assert.equal(items[0].rel, 'b.jpg');
  assert.ok(events.some((e) => e.type === 'phase'));
  await fs.rm(root, { recursive: true });
});

test('runPlan 报告中带上 _trash 路径', async () => {
  const root = await tmpRoot();
  const plan = { root, dupGroups: [], imageTasks: [], videoTasks: [] };
  const report = await runPlan(plan, {}, () => {});
  assert.equal(report.trashDir, path.join(root, '_trash'));
  await fs.rm(root, { recursive: true });
});
