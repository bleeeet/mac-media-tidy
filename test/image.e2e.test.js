import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run } from '../lib/exec.js';
import { probeImage, processImage, dimensionLadder } from '../lib/image.js';
import { Trash } from '../lib/trash.js';
import { MAX_IMAGE_BYTES } from '../lib/video-rules.js';

const isMac = process.platform === 'darwin';
const ICNS =
  '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericFolderIcon.icns';

// 用系统图标生成指定格式的测试图片
async function makeImage(dir, name, format, extraArgs = []) {
  const out = path.join(dir, name);
  const { code, stderr } = await run('sips', [
    '-s', 'format', format, ...extraArgs, ICNS, '--out', out,
  ]);
  if (code !== 0) throw new Error(`生成测试图片失败: ${stderr}`);
  return out;
}

async function itemOf(filePath, rel) {
  const stat = await fs.stat(filePath);
  return {
    path: filePath,
    rel,
    size: stat.size,
    mtime: stat.mtimeMs,
    ext: path.extname(filePath).slice(1).toLowerCase(),
  };
}

test('probeImage 读出尺寸与 alpha', { skip: !isMac }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'img-'));
  const png = await makeImage(root, 'x.png', 'png');

  const info = await probeImage(png);
  assert.ok(info.width > 0, `width=${info.width}`);
  assert.ok(info.height > 0);
  assert.equal(typeof info.hasAlpha, 'boolean');
  await fs.rm(root, { recursive: true });
});

test('processImage 对达标图片返回 skipped 且不改动文件', { skip: !isMac }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'img2-'));
  const jpg = await makeImage(root, 'small.jpg', 'jpeg', ['-Z', '400']);

  const item = await itemOf(jpg, 'small.jpg');
  assert.ok(item.size < MAX_IMAGE_BYTES);
  const result = await processImage(item, { trash: new Trash(root) });

  assert.equal(result.action, 'skipped');
  assert.equal((await fs.stat(jpg)).size, item.size);
  await fs.rm(root, { recursive: true });
});

test('processImage 把超过 3MB 的 jpg 压到限额内', { skip: !isMac }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'img3-'));
  // 用高质量大尺寸构造一张超过 3MB 的 jpg
  const jpg = await makeImage(root, 'big.jpg', 'jpeg', [
    '-s', 'formatOptions', 'best', '-z', '4000', '4000',
  ]);
  const item = await itemOf(jpg, 'big.jpg');
  assert.ok(item.size > MAX_IMAGE_BYTES, `构造的测试图仅 ${item.size} 字节`);

  const result = await processImage(item, { trash: new Trash(root) });

  assert.equal(result.action, 'image-compressed');
  assert.ok(result.after <= MAX_IMAGE_BYTES, `压后仍有 ${result.after} 字节`);
  assert.ok(result.after < result.before);
  // 原件进了回收站
  await fs.access(path.join(root, '_trash', 'big.jpg'));
  // 修改时间被还原
  const finalStat = await fs.stat(result.to);
  assert.ok(Math.abs(finalStat.mtimeMs - item.mtime) < 1000);
  await fs.rm(root, { recursive: true });
});

test('processImage 保留带 alpha 的 PNG 不转 JPG 且缩到限额内', { skip: !isMac }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'img4-'));
  const png = await makeImage(root, 'big.png', 'png', ['-z', '4000', '4000']);
  const info = await probeImage(png);
  const item = await itemOf(png, 'big.png');

  assert.equal(info.hasAlpha, true, '测试素材应带 alpha 通道');
  assert.ok(item.size > MAX_IMAGE_BYTES, `测试素材应超过 3MB，实际 ${item.size}`);

  const result = await processImage(item, { trash: new Trash(root) });

  assert.equal(result.action, 'image-compressed');
  assert.equal(path.extname(result.to), '.png', '带 alpha 的图不应被转成 JPG');
  assert.ok(result.after <= MAX_IMAGE_BYTES, `压后仍有 ${result.after} 字节`);
  await fs.rm(root, { recursive: true });
});

test('processImage 把 HEIC 转成同名 JPG 并把原件收进 _trash', { skip: !isMac }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'img5-'));
  const heic = await makeImage(root, 'photo.heic', 'heic', ['-Z', '1200']);
  const item = await itemOf(heic, 'photo.heic');

  const result = await processImage(item, { trash: new Trash(root) });

  assert.equal(result.action, 'heic-converted');
  assert.equal(result.to, path.join(root, 'photo.jpg'));
  await fs.access(path.join(root, 'photo.jpg'));
  await assert.rejects(fs.access(heic), '原 HEIC 不应留在原地');
  await fs.access(path.join(root, '_trash', 'photo.heic'));

  // 产物确实是一张可读的 JPEG
  const info = await probeImage(result.to);
  assert.ok(info.width > 0);
  assert.match(info.format, /jpeg/i);

  // 修改时间被还原
  const finalStat = await fs.stat(result.to);
  assert.ok(Math.abs(finalStat.mtimeMs - item.mtime) < 1000);
  await fs.rm(root, { recursive: true });
});

test('dimensionLadder 只给出比原图更小的档位', () => {
  assert.deepEqual(dimensionLadder(4000), [3000, 2000, 1500]);
  assert.deepEqual(dimensionLadder(5000), [4000, 3000, 2000, 1500]);
  assert.deepEqual(dimensionLadder(1600), [1500]);
  // 原图本就很小，无从缩起，返回原尺寸兜底
  assert.deepEqual(dimensionLadder(800), [800]);
});
