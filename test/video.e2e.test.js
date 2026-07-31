import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run, commandExists } from '../lib/exec.js';
import { probeVideo, processVideo } from '../lib/video.js';
import { Trash } from '../lib/trash.js';

const hasFfmpeg = await commandExists('ffmpeg');

async function makeVideo(dir, name, size, fps, seconds = 2) {
  const out = path.join(dir, name);
  const { code, stderr } = await run('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${fps}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-b:v', '8M', '-c:a', 'aac', '-y', out,
  ]);
  if (code !== 0) throw new Error(`生成测试视频失败: ${stderr.slice(-300)}`);
  return out;
}

async function itemOf(filePath, rel) {
  const stat = await fs.stat(filePath);
  return {
    path: filePath, rel, size: stat.size, mtime: stat.mtimeMs,
    ext: path.extname(filePath).slice(1).toLowerCase(),
  };
}

test('probeVideo 读出分辨率与帧率', { skip: !hasFfmpeg }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vid-'));
  const file = await makeVideo(root, 'a.mp4', '1280x720', 30);
  const info = await probeVideo(file);
  assert.equal(info.width, 1280);
  assert.equal(info.height, 720);
  assert.ok(Math.abs(info.fps - 30) < 0.5);
  assert.ok(info.duration > 1);
  assert.ok(info.bitrate > 0);
  await fs.rm(root, { recursive: true });
});

test('processVideo 把 4K60 压成 1080p30 的 H.265', { skip: !hasFfmpeg }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vid2-'));
  const file = await makeVideo(root, 'big.mp4', '3840x2160', 60);
  const item = await itemOf(file, 'big.mp4');

  const ratios = [];
  const result = await processVideo(item, {
    trash: new Trash(root),
    encoder: 'hevc_videotoolbox',
    onProgress: (r) => ratios.push(r),
  });

  assert.equal(result.action, 'video-compressed', result.error || '');
  assert.ok(result.after < result.before);

  const out = await probeVideo(result.to);
  assert.equal(out.width, 1920);
  assert.equal(out.height, 1080);
  assert.ok(out.fps <= 31, `fps=${out.fps}`);
  assert.equal(out.codec, 'hevc');

  // 原件进了回收站
  await fs.access(path.join(root, '_trash', 'big.mp4'));
  // 进度确实被上报过
  assert.ok(ratios.length > 0, '应至少上报一次进度');
  await fs.rm(root, { recursive: true });
});

test('processVideo 把竖屏 4K 压成 1080x1920 而非横过来', { skip: !hasFfmpeg }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vid4-'));
  const file = await makeVideo(root, 'portrait.mp4', '2160x3840', 30);
  const item = await itemOf(file, 'portrait.mp4');

  const result = await processVideo(item, {
    trash: new Trash(root), encoder: 'hevc_videotoolbox',
  });
  assert.equal(result.action, 'video-compressed', result.error || '');

  const out = await probeVideo(result.to);
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1920);
  await fs.rm(root, { recursive: true });
});

test('processVideo 跳过已达标视频', { skip: !hasFfmpeg }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vid3-'));
  const file = path.join(root, 'ok.mp4');
  const { code, stderr } = await run('ffmpeg', [
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2',
    '-c:v', 'libx265', '-tag:v', 'hvc1', '-b:v', '1M', '-y', file,
  ]);
  if (code !== 0) throw new Error(`生成测试视频失败: ${stderr.slice(-300)}`);

  const item = await itemOf(file, 'ok.mp4');
  const result = await processVideo(item, {
    trash: new Trash(root), encoder: 'hevc_videotoolbox',
  });

  assert.equal(result.action, 'skipped');
  await fs.access(file);
  await fs.rm(root, { recursive: true });
});
