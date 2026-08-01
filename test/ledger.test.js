import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Ledger, LEDGER_FILE } from '../lib/ledger.js';

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
}

async function statOf(filePath) {
  const s = await fs.stat(filePath);
  return { size: s.size, mtime: s.mtimeMs };
}

test('record 后 has 命中同一个文件', async () => {
  const root = await tmpRoot();
  const file = path.join(root, 'a.jpg');
  await fs.writeFile(file, 'x'.repeat(100));

  const ledger = new Ledger(root);
  await ledger.record(file, 'image-compressed');

  const { size, mtime } = await statOf(file);
  assert.equal(ledger.has('a.jpg', size, mtime), true);
  await fs.rm(root, { recursive: true });
});

test('has 对没记录过的文件返回 false', async () => {
  const root = await tmpRoot();
  const ledger = new Ledger(root);
  assert.equal(ledger.has('never.jpg', 1, 1), false);
  await fs.rm(root, { recursive: true });
});

test('文件体积或时间变了记录即失效', async () => {
  const root = await tmpRoot();
  const file = path.join(root, 'a.jpg');
  await fs.writeFile(file, 'x'.repeat(100));

  const ledger = new Ledger(root);
  await ledger.record(file, 'image-compressed');
  const { size, mtime } = await statOf(file);

  assert.equal(ledger.has('a.jpg', size + 1, mtime), false);
  assert.equal(ledger.has('a.jpg', size, mtime + 5000), false);
  await fs.rm(root, { recursive: true });
});

test('记录写在 .media-kit.json 且能被新实例读回', async () => {
  const root = await tmpRoot();
  const file = path.join(root, 'sub', 'a.jpg');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'x');

  await new Ledger(root).record(file, 'video-compressed');

  const raw = JSON.parse(await fs.readFile(path.join(root, LEDGER_FILE), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.files[path.join('sub', 'a.jpg')].action, 'video-compressed');

  const reloaded = new Ledger(root);
  await reloaded.load();
  const { size, mtime } = await statOf(file);
  assert.equal(reloaded.has(path.join('sub', 'a.jpg'), size, mtime), true);
  await fs.rm(root, { recursive: true });
});

test('记录文件损坏时当作空记录而不是崩溃', async () => {
  const root = await tmpRoot();
  await fs.writeFile(path.join(root, LEDGER_FILE), '{ 这不是 json');

  const ledger = new Ledger(root);
  await ledger.load();

  assert.deepEqual(ledger.files, {});
  await fs.rm(root, { recursive: true });
});

test('并发 record 不会写坏记录文件', async () => {
  const root = await tmpRoot();
  const files = [];
  for (let i = 0; i < 20; i += 1) {
    const file = path.join(root, `f${i}.jpg`);
    await fs.writeFile(file, 'x'.repeat(i + 1));
    files.push(file);
  }

  const ledger = new Ledger(root);
  await Promise.all(files.map((f) => ledger.record(f, 'image-compressed')));

  const raw = JSON.parse(await fs.readFile(path.join(root, LEDGER_FILE), 'utf8'));
  assert.equal(Object.keys(raw.files).length, 20);
  await fs.rm(root, { recursive: true });
});
