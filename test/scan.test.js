import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanFolder, isProcessableImage, BACKUP_DIR } from '../lib/scan.js';

async function makeTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-'));
  await fs.mkdir(path.join(root, 'sub'));
  await fs.mkdir(path.join(root, '_trash'));
  await fs.mkdir(path.join(root, '.hidden'));
  await fs.writeFile(path.join(root, 'a.jpg'), 'a');
  await fs.writeFile(path.join(root, 'b.HEIC'), 'b');
  await fs.writeFile(path.join(root, 'sub', 'c.mp4'), 'c');
  await fs.writeFile(path.join(root, 'sub', 'd.gif'), 'd');
  await fs.writeFile(path.join(root, 'notes.txt'), 'x');
  await fs.writeFile(path.join(root, '.DS_Store'), 'x');
  await fs.writeFile(path.join(root, '_trash', 'old.jpg'), 'x');
  await fs.writeFile(path.join(root, '.hidden', 'e.jpg'), 'x');
  return root;
}

test('scanFolder 按类型收集文件', async () => {
  const root = await makeTree();
  const { images, videos } = await scanFolder(root);
  assert.deepEqual(images.map((i) => i.rel).sort(), ['a.jpg', 'b.HEIC', 'sub/d.gif']);
  assert.deepEqual(videos.map((i) => i.rel), ['sub/c.mp4']);
  await fs.rm(root, { recursive: true });
});

test('scanFolder 跳过 _trash、隐藏文件与非媒体文件', async () => {
  const root = await makeTree();
  const { images } = await scanFolder(root);
  const rels = images.map((i) => i.rel);
  assert.ok(!rels.some((r) => r.startsWith('_trash')));
  assert.ok(!rels.some((r) => r.startsWith('.hidden')));
  assert.ok(!rels.includes('notes.txt'));
  await fs.rm(root, { recursive: true });
});

test('scanFolder 返回 size 与 mtime', async () => {
  const root = await makeTree();
  const { images } = await scanFolder(root);
  const a = images.find((i) => i.rel === 'a.jpg');
  assert.equal(a.size, 1);
  assert.ok(a.mtime > 0);
  assert.equal(a.ext, 'jpg');
  assert.ok(path.isAbsolute(a.path));
  await fs.rm(root, { recursive: true });
});

test('isProcessableImage 排除 gif/webp/bmp', () => {
  assert.equal(isProcessableImage('jpg'), true);
  assert.equal(isProcessableImage('heic'), true);
  assert.equal(isProcessableImage('png'), true);
  assert.equal(isProcessableImage('gif'), false);
  assert.equal(isProcessableImage('webp'), false);
  assert.equal(isProcessableImage('bmp'), false);
});

test('scanFolder 跳过本工具建的「原图」，但不跳过用户自己的同名文件夹', async () => {
  const mine = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-mine-'));
  await fs.mkdir(path.join(mine, BACKUP_DIR));
  await fs.writeFile(path.join(mine, BACKUP_DIR, 'photo.jpg'), 'x');

  const rels = (await scanFolder(mine)).images.map((i) => i.rel);
  assert.deepEqual(rels, [path.join(BACKUP_DIR, 'photo.jpg')]);

  // 放进 manifest.json 后它就成了本工具的备份目录，应当被跳过
  await fs.writeFile(path.join(mine, BACKUP_DIR, 'manifest.json'), '[]');
  assert.deepEqual((await scanFolder(mine)).images, []);
  await fs.rm(mine, { recursive: true });
});
