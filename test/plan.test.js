import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { estimateSaving, buildPlan } from '../lib/plan.js';
import { MAX_IMAGE_BYTES, MIN_VIDEO_BYTES } from '../lib/video-rules.js';
import { Ledger } from '../lib/ledger.js';

test('estimateSaving 累加重复文件字节', () => {
  const plan = {
    dupGroups: [{ size: 1000, remove: [{}, {}] }],
    imageTasks: [],
    videoTasks: [],
  };
  assert.equal(estimateSaving(plan), 2000);
});

test('estimateSaving 按目标码率估算视频收益', () => {
  const plan = {
    dupGroups: [],
    imageTasks: [],
    // 10 秒、10MB 的视频，目标 2Mbps → 约 2.5MB，收益约 7.5MB
    videoTasks: [{ item: { size: 10_000_000 }, info: { duration: 10 } }],
  };
  const saving = estimateSaving(plan);
  assert.ok(saving > 7_000_000 && saving < 8_000_000, `saving=${saving}`);
});

test('estimateSaving 对无收益项不给负数', () => {
  const plan = {
    dupGroups: [],
    imageTasks: [],
    videoTasks: [{ item: { size: 100 }, info: { duration: 100 } }],
  };
  assert.equal(estimateSaving(plan), 0);
});

test('estimateSaving 按 3MB 上限估算图片收益', () => {
  const plan = {
    dupGroups: [],
    imageTasks: [
      { item: { size: MAX_IMAGE_BYTES + 1_000_000 }, decision: { compress: true } },
      { item: { size: 500 }, decision: { convert: true, compress: false } },
    ],
    videoTasks: [],
  };
  assert.equal(estimateSaving(plan), 1_000_000);
});

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'plan-'));
}

test('buildPlan 跳过记录里已处理过的图片', async () => {
  const root = await tmpRoot();
  const big = path.join(root, 'big.jpg');
  await fs.writeFile(big, 'x'.repeat(MAX_IMAGE_BYTES + 1000));

  const before = await buildPlan(root);
  assert.equal(before.imageTasks.length, 1);
  assert.equal(before.stats.skippedCount, 0);

  await new Ledger(root).record(big, 'image-compressed');

  const after = await buildPlan(root);
  assert.equal(after.imageTasks.length, 0);
  assert.equal(after.stats.skippedCount, 1);
  await fs.rm(root, { recursive: true });
});

test('文件被改动后记录失效，重新进入计划', async () => {
  const root = await tmpRoot();
  const big = path.join(root, 'big.jpg');
  await fs.writeFile(big, 'x'.repeat(MAX_IMAGE_BYTES + 1000));
  await new Ledger(root).record(big, 'image-compressed');

  await fs.writeFile(big, 'y'.repeat(MAX_IMAGE_BYTES + 2000));

  const plan = await buildPlan(root);
  assert.equal(plan.imageTasks.length, 1);
  assert.equal(plan.stats.skippedCount, 0);
  await fs.rm(root, { recursive: true });
});

// 命中记录的视频压根不该走 ffprobe：这里放的是假 mp4，真去 probe 会失败。
// 体积必须够大，否则会先被 10MB 规则拦下，测不到记录这条路径。
test('buildPlan 对已处理过的视频不再调用 ffprobe', async () => {
  const root = await tmpRoot();
  const fake = path.join(root, 'v.mp4');
  await fs.writeFile(fake, '');
  await fs.truncate(fake, MIN_VIDEO_BYTES);
  await new Ledger(root).record(fake, 'video-compressed');

  const plan = await buildPlan(root);
  assert.equal(plan.videoTasks.length, 0);
  assert.equal(plan.stats.skippedCount, 1);
  await fs.rm(root, { recursive: true });
});

// 小视频连 ffprobe 都不该走：这里放的是假 mp4，真去 probe 会失败
test('buildPlan 不把小于 10MB 的视频列入压制计划', async () => {
  const root = await tmpRoot();
  const small = path.join(root, 'small.mp4');
  await fs.writeFile(small, '');
  await fs.truncate(small, MIN_VIDEO_BYTES - 1);

  const plan = await buildPlan(root);

  assert.equal(plan.videoTasks.length, 0);
  assert.equal(plan.stats.videoCount, 1);
  assert.equal(plan.stats.videoCompressCount, 0);
  assert.equal(plan.stats.skippedCount, 0, '体积小不算「已处理过」');
  await fs.rm(root, { recursive: true });
});
