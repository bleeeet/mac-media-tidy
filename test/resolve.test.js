import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listDirs, validateFolder, matchScore } from '../lib/resolve.js';

test('matchScore 统计名称与大小都匹配的样本数', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'res-'));
  await fs.writeFile(path.join(root, 'a.jpg'), 'abcd');
  await fs.writeFile(path.join(root, 'b.jpg'), 'ef');

  assert.equal(await matchScore(root, [{ name: 'a.jpg', size: 4 }, { name: 'b.jpg', size: 2 }]), 2);
  assert.equal(await matchScore(root, [{ name: 'a.jpg', size: 999 }]), 0);
  assert.equal(await matchScore(root, [{ name: 'zzz.jpg', size: 4 }]), 0);
  await fs.rm(root, { recursive: true });
});

test('listDirs 只列出子目录并给出上级', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'res2-'));
  await fs.mkdir(path.join(root, 'x'));
  await fs.mkdir(path.join(root, '.hidden'));
  await fs.writeFile(path.join(root, 'f.txt'), '');

  const result = await listDirs(root);
  assert.deepEqual(result.dirs.map((d) => d.name), ['x']);
  assert.equal(result.parent, path.dirname(root));
  await fs.rm(root, { recursive: true });
});

test('validateFolder 拒绝不存在的路径与文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'res3-'));
  const file = path.join(root, 'f.txt');
  await fs.writeFile(file, '');

  assert.equal((await validateFolder(path.join(root, 'nope'))).ok, false);
  assert.equal((await validateFolder(file)).ok, false);
  assert.equal((await validateFolder(root)).ok, true);
  await fs.rm(root, { recursive: true });
});

test('validateFolder 展开 ~ 前缀', async () => {
  const result = await validateFolder('~');
  assert.equal(result.ok, true);
  assert.equal(result.path, os.homedir());
});

test('validateFolder 容忍首尾空白与 Finder 拖入产生的转义空格', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'res4-'));
  const withSpace = path.join(root, 'my folder');
  await fs.mkdir(withSpace);

  assert.equal((await validateFolder(`  ${root}  `)).ok, true);
  const escaped = withSpace.replace(/ /g, '\\ ');
  const result = await validateFolder(escaped);
  assert.equal(result.ok, true, `未能解析转义路径 ${escaped}`);
  assert.equal(result.path, withSpace);
  await fs.rm(root, { recursive: true });
});
