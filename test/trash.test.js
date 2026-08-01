import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Trash } from '../lib/trash.js';
import { BACKUP_DIR, BACKUP_DIR_ALT } from '../lib/scan.js';

async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trash-'));
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  return root;
}

test('move 把文件搬到备份目录并保留相对路径', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'sub', 'a.jpg');
  await fs.writeFile(src, 'data');

  const trash = new Trash(root);
  const { to } = await trash.move(src, 'duplicate');

  assert.equal(to, path.join(root, BACKUP_DIR, 'sub', 'a.jpg'));
  assert.equal(await fs.readFile(to, 'utf8'), 'data');
  await assert.rejects(fs.access(src));
  await fs.rm(root, { recursive: true });
});

test('move 在目标同名时追加序号', async () => {
  const root = await tmpRoot();
  const first = path.join(root, 'a.jpg');
  await fs.writeFile(first, '1');
  const trash = new Trash(root);
  await trash.move(first, 'r1');

  await fs.writeFile(first, '2');
  const { to } = await trash.move(first, 'r2');

  assert.equal(path.basename(to), 'a-1.jpg');
  assert.equal(await fs.readFile(to, 'utf8'), '2');
  await fs.rm(root, { recursive: true });
});

test('move 写入 manifest.json', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'a.jpg');
  await fs.writeFile(src, 'x');
  const trash = new Trash(root);
  await trash.move(src, 'heic-converted');

  const raw = await fs.readFile(path.join(root, BACKUP_DIR, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].reason, 'heic-converted');
  assert.equal(manifest[0].action, 'trash');
  assert.ok(manifest[0].ts > 0);
  await fs.rm(root, { recursive: true });
});

test('新的 Trash 实例会续写已有 manifest', async () => {
  const root = await tmpRoot();
  await fs.writeFile(path.join(root, 'a.jpg'), 'x');
  await new Trash(root).move(path.join(root, 'a.jpg'), 'r1');

  await fs.writeFile(path.join(root, 'b.jpg'), 'y');
  const trash2 = new Trash(root);
  await trash2.load();
  await trash2.move(path.join(root, 'b.jpg'), 'r2');

  const raw = await fs.readFile(path.join(root, BACKUP_DIR, 'manifest.json'), 'utf8');
  assert.equal(JSON.parse(raw).length, 2);
  await fs.rm(root, { recursive: true });
});

test('backup:false 时直接删除且不建备份目录', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'a.jpg');
  await fs.writeFile(src, 'x');

  const trash = new Trash(root, { backup: false });
  await trash.load();
  const { to } = await trash.move(src, 'duplicate');

  assert.equal(to, null);
  assert.equal(trash.trashDir, null);
  await assert.rejects(fs.access(src));
  await assert.rejects(fs.access(path.join(root, BACKUP_DIR)));
  await fs.rm(root, { recursive: true });
});

// 「原图」是用户自己给照片目录起的常见名字，不能直接往里塞东西
test('已有同名「原图」文件夹时退让到「原图-备份」', async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, BACKUP_DIR));
  await fs.writeFile(path.join(root, BACKUP_DIR, 'mine.jpg'), 'user');
  const src = path.join(root, 'a.jpg');
  await fs.writeFile(src, 'x');

  const trash = new Trash(root);
  const { to } = await trash.move(src, 'duplicate');

  assert.equal(to, path.join(root, BACKUP_DIR_ALT, 'a.jpg'));
  assert.equal(await fs.readFile(path.join(root, BACKUP_DIR, 'mine.jpg'), 'utf8'), 'user');
  await fs.rm(root, { recursive: true });
});

test('本工具建的「原图」文件夹会被续用', async () => {
  const root = await tmpRoot();
  await fs.writeFile(path.join(root, 'a.jpg'), 'x');
  await new Trash(root).move(path.join(root, 'a.jpg'), 'r1');

  await fs.writeFile(path.join(root, 'b.jpg'), 'y');
  const { to } = await new Trash(root).move(path.join(root, 'b.jpg'), 'r2');

  assert.equal(to, path.join(root, BACKUP_DIR, 'b.jpg'));
  await fs.rm(root, { recursive: true });
});
