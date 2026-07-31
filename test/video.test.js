import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgressTime, buildFfmpegArgs } from '../lib/video.js';

test('parseProgressTime 解析 ffmpeg 进度', () => {
  assert.ok(Math.abs(parseProgressTime('frame= 100 time=00:00:12.34 bitrate=') - 12.34) < 0.01);
  assert.ok(Math.abs(parseProgressTime('time=01:02:03.00') - 3723) < 0.01);
});

test('parseProgressTime 对无匹配返回 null', () => {
  assert.equal(parseProgressTime('frame= 100 fps=25'), null);
  assert.equal(parseProgressTime(''), null);
});

test('buildFfmpegArgs 包含 hvc1 tag 与目标码率', () => {
  const args = buildFfmpegArgs('in.mov', 'out.mp4', {
    width: 3840, height: 2160, fps: 60, bitrate: 50_000_000, duration: 10, codec: 'h264',
  }, 'hevc_videotoolbox');
  const joined = args.join(' ');
  assert.ok(joined.includes('-tag:v hvc1'));
  assert.ok(joined.includes('-c:v hevc_videotoolbox'));
  assert.ok(joined.includes('-b:v 2M'));
  assert.ok(joined.includes('-maxrate 3M'));
  assert.ok(joined.includes('scale=1920:1080'));
  assert.ok(joined.includes('-r 30'));
  assert.ok(joined.includes('-c:a aac'));
  assert.ok(joined.includes('-movflags +faststart'));
});

test('buildFfmpegArgs 对已达标帧率不加 -r', () => {
  const args = buildFfmpegArgs('in.mov', 'out.mp4', {
    width: 3840, height: 2160, fps: 24, bitrate: 50_000_000, duration: 10, codec: 'h264',
  }, 'hevc_videotoolbox');
  assert.ok(!args.includes('-r'));
});

test('buildFfmpegArgs 对无需缩放的竖屏不加 scale', () => {
  const args = buildFfmpegArgs('in.mov', 'out.mp4', {
    width: 1080, height: 1920, fps: 30, bitrate: 20_000_000, duration: 10, codec: 'h264',
  }, 'hevc_videotoolbox');
  assert.ok(!args.join(' ').includes('scale='));
});

test('buildFfmpegArgs 支持切换到 libx265', () => {
  const args = buildFfmpegArgs('in.mov', 'out.mp4', {
    width: 1920, height: 1080, fps: 30, bitrate: 20_000_000, duration: 10, codec: 'h264',
  }, 'libx265');
  assert.ok(args.join(' ').includes('-c:v libx265'));
});
