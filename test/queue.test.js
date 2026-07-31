import test from 'node:test';
import assert from 'node:assert/strict';
import { runQueue } from '../lib/queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runQueue 保持结果顺序与输入一致', async () => {
  const tasks = [30, 10, 20].map((ms, i) => async () => {
    await sleep(ms);
    return i;
  });
  assert.deepEqual(await runQueue(tasks, 3), [0, 1, 2]);
});

test('runQueue 不超过并发上限', async () => {
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 10 }, () => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(10);
    active -= 1;
    return true;
  });
  await runQueue(tasks, 3);
  assert.ok(peak <= 3, `peak=${peak}`);
});

test('runQueue 把失败任务记为 null 且不中断其他任务', async () => {
  const tasks = [
    async () => 'ok1',
    async () => {
      throw new Error('boom');
    },
    async () => 'ok2',
  ];
  assert.deepEqual(await runQueue(tasks, 2), ['ok1', null, 'ok2']);
});

test('runQueue 处理空任务列表', async () => {
  assert.deepEqual(await runQueue([], 4), []);
});
