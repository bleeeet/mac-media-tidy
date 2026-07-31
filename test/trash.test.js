import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Trash } from '../lib/trash.js';

async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trash-'));
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  return root;
}

test('move 把文件搬到 _trash 并保留相对路径', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'sub', 'a.jpg');
  await fs.writeFile(src, 'data');

  const trash = new Trash(root);
  const { to } = await trash.move(src, 'duplicate');

  assert.equal(to, path.join(root, '_trash', 'sub', 'a.jpg'));
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

  const raw = await fs.readFile(path.join(root, '_trash', 'manifest.json'), 'utf8');
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

  const raw = await fs.readFile(path.join(root, '_trash', 'manifest.json'), 'utf8');
  assert.equal(JSON.parse(raw).length, 2);
  await fs.rm(root, { recursive: true });
});
