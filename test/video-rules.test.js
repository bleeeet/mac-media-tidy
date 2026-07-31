import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFps, targetSize, needsCompress } from '../lib/video-rules.js';

test('parseFps 解析分数帧率', () => {
  assert.equal(parseFps('30/1'), 30);
  assert.ok(Math.abs(parseFps('30000/1001') - 29.97) < 0.01);
  assert.equal(parseFps('60/1'), 60);
});

test('parseFps 对非法输入返回 null', () => {
  assert.equal(parseFps('0/0'), null);
  assert.equal(parseFps(''), null);
  assert.equal(parseFps(undefined), null);
});

test('targetSize 把横屏 4K 缩到 1920x1080', () => {
  assert.deepEqual(targetSize(3840, 2160), { width: 1920, height: 1080 });
});

test('targetSize 保持竖屏 1080x1920 不变', () => {
  assert.deepEqual(targetSize(1080, 1920), { width: 1080, height: 1920 });
});

test('targetSize 把竖屏 4K 缩到 1080x1920', () => {
  assert.deepEqual(targetSize(2160, 3840), { width: 1080, height: 1920 });
});

test('targetSize 不放大小视频', () => {
  assert.deepEqual(targetSize(1280, 720), { width: 1280, height: 720 });
});

test('targetSize 对 4:3 素材以短边 1080 为准', () => {
  assert.deepEqual(targetSize(4000, 3000), { width: 1440, height: 1080 });
});

test('targetSize 输出恒为偶数', () => {
  const r = targetSize(1919, 1079);
  assert.equal(r.width % 2, 0);
  assert.equal(r.height % 2, 0);
});

test('needsCompress 对达标视频返回空数组', () => {
  assert.deepEqual(
    needsCompress({ width: 1920, height: 1080, fps: 30, bitrate: 2_000_000 }),
    []
  );
});

test('needsCompress 容忍 29.97 不判为超帧率', () => {
  assert.deepEqual(
    needsCompress({ width: 1920, height: 1080, fps: 29.97, bitrate: 1_000_000 }),
    []
  );
});

test('needsCompress 命中分辨率', () => {
  assert.deepEqual(
    needsCompress({ width: 3840, height: 2160, fps: 30, bitrate: 1_000_000 }),
    ['resolution']
  );
});

test('needsCompress 命中帧率', () => {
  assert.deepEqual(
    needsCompress({ width: 1280, height: 720, fps: 60, bitrate: 1_000_000 }),
    ['fps']
  );
});

test('needsCompress 命中码率', () => {
  assert.deepEqual(
    needsCompress({ width: 1920, height: 1080, fps: 30, bitrate: 20_000_000 }),
    ['bitrate']
  );
});

test('needsCompress 在码率未知时不以码率触发', () => {
  assert.deepEqual(
    needsCompress({ width: 1920, height: 1080, fps: 30, bitrate: null }),
    []
  );
});

test('needsCompress 可同时命中多个条件', () => {
  assert.deepEqual(
    needsCompress({ width: 3840, height: 2160, fps: 60, bitrate: 50_000_000 }),
    ['resolution', 'fps', 'bitrate']
  );
});
