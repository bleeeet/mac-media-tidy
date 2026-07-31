import test from 'node:test';
import assert from 'node:assert/strict';
import { planImage, qualityLadder } from '../lib/image.js';
import { MAX_IMAGE_BYTES } from '../lib/video-rules.js';

test('planImage 对 heic 要求转换', () => {
  const r = planImage({ ext: 'heic', size: 1000 });
  assert.equal(r.convert, true);
});

test('planImage 对小体积 jpg 不做任何事', () => {
  const r = planImage({ ext: 'jpg', size: 1000 });
  assert.deepEqual(r, { convert: false, compress: false });
});

test('planImage 对超过 3MB 的 jpg 要求压缩', () => {
  const r = planImage({ ext: 'jpg', size: MAX_IMAGE_BYTES + 1 });
  assert.deepEqual(r, { convert: false, compress: true });
});

test('planImage 对超大 heic 同时要求转换与压缩', () => {
  const r = planImage({ ext: 'heic', size: MAX_IMAGE_BYTES + 1 });
  assert.deepEqual(r, { convert: true, compress: true });
});

test('planImage 忽略仅去重格式', () => {
  const r = planImage({ ext: 'gif', size: MAX_IMAGE_BYTES * 5 });
  assert.deepEqual(r, { convert: false, compress: false });
});

test('qualityLadder 为固定的递减序列', () => {
  assert.deepEqual(qualityLadder(), [85, 75, 65, 55]);
});
