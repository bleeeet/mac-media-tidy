import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hashFile, findDuplicates } from '../lib/dedup.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dedup-'));
}

async function makeItem(root, rel, content, mtimeMs) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  const stat = await fs.stat(full);
  return { path: full, rel, size: stat.size, mtime: mtimeMs ?? stat.mtimeMs, ext: 'jpg' };
}

test('hashFile 对相同内容给出相同哈希', async () => {
  const root = await tmpDir();
  const a = await makeItem(root, 'a.jpg', 'hello');
  const b = await makeItem(root, 'b.jpg', 'hello');
  assert.equal(await hashFile(a.path), await hashFile(b.path));
  await fs.rm(root, { recursive: true });
});

test('findDuplicates 找出同内容文件并保留最早的', async () => {
  const root = await tmpDir();
  const older = await makeItem(root, 'older.jpg', 'same', 1000);
  const newer = await makeItem(root, 'newer.jpg', 'same', 2000);
  const groups = await findDuplicates([newer, older]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep.rel, 'older.jpg');
  assert.deepEqual(groups[0].remove.map((i) => i.rel), ['newer.jpg']);
  await fs.rm(root, { recursive: true });
});

test('findDuplicates 忽略大小相同但内容不同的文件', async () => {
  const root = await tmpDir();
  const a = await makeItem(root, 'a.jpg', 'aaaa');
  const b = await makeItem(root, 'b.jpg', 'bbbb');
  assert.equal(a.size, b.size);
  assert.deepEqual(await findDuplicates([a, b]), []);
  await fs.rm(root, { recursive: true });
});

test('findDuplicates 对唯一文件不计算哈希也不成组', async () => {
  const root = await tmpDir();
  const a = await makeItem(root, 'a.jpg', 'unique-content');
  assert.deepEqual(await findDuplicates([a]), []);
  await fs.rm(root, { recursive: true });
});

test('findDuplicates 处理三份以上重复', async () => {
  const root = await tmpDir();
  const a = await makeItem(root, 'a.jpg', 'x', 1000);
  const b = await makeItem(root, 'b.jpg', 'x', 2000);
  const c = await makeItem(root, 'c.jpg', 'x', 3000);
  const groups = await findDuplicates([c, b, a]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep.rel, 'a.jpg');
  assert.deepEqual(groups[0].remove.map((i) => i.rel).sort(), ['b.jpg', 'c.jpg']);
  await fs.rm(root, { recursive: true });
});

test('findDuplicates 在 mtime 相同时按路径字典序保留', async () => {
  const root = await tmpDir();
  const a = await makeItem(root, 'b.jpg', 'y', 5000);
  const b = await makeItem(root, 'a.jpg', 'y', 5000);
  const groups = await findDuplicates([a, b]);
  assert.equal(groups[0].keep.rel, 'a.jpg');
  await fs.rm(root, { recursive: true });
});
