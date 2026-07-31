import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateSaving } from '../lib/plan.js';
import { MAX_IMAGE_BYTES } from '../lib/video-rules.js';

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
