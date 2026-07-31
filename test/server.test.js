import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../server.js';

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

function postJson(base, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /api/health 返回依赖检测结果', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.ffmpeg, 'boolean');
    assert.equal(typeof body.sips, 'boolean');
    assert.equal(typeof body.encoder, 'string');
  });
});

test('POST /api/validate 拒绝不存在的路径', async () => {
  await withServer(async (base) => {
    const res = await postJson(base, '/api/validate', { path: '/definitely/not/here' });
    const body = await res.json();
    assert.equal(body.ok, false);
  });
});

test('GET /api/ls 列出子目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
  await fs.mkdir(path.join(root, 'inner'));
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ls?path=${encodeURIComponent(root)}`);
    const body = await res.json();
    assert.deepEqual(body.dirs.map((d) => d.name), ['inner']);
  });
  await fs.rm(root, { recursive: true });
});

test('POST /api/scan 返回统计且不修改文件夹', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'srv2-'));
  await fs.writeFile(path.join(root, 'a.jpg'), 'same');
  await fs.writeFile(path.join(root, 'b.jpg'), 'same');

  await withServer(async (base) => {
    const res = await postJson(base, '/api/scan', { path: root });
    const body = await res.json();
    assert.equal(body.stats.imageCount, 2);
    assert.equal(body.stats.dupCount, 1);
    assert.ok(body.jobId);
  });

  // 只读校验：两个文件都还在，且没有 _trash
  await fs.access(path.join(root, 'a.jpg'));
  await fs.access(path.join(root, 'b.jpg'));
  await assert.rejects(fs.access(path.join(root, '_trash')));
  await fs.rm(root, { recursive: true });
});

test('POST /api/run 走完整流程并通过 SSE 推送完成事件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'srv3-'));
  await fs.writeFile(path.join(root, 'a.jpg'), 'same');
  await fs.writeFile(path.join(root, 'b.jpg'), 'same');

  await withServer(async (base) => {
    const scan = await (await postJson(base, '/api/scan', { path: root })).json();
    await postJson(base, '/api/run', { jobId: scan.jobId, options: { dedup: true } });

    // SSE 是纯文本流，直接读到底即可
    const res = await fetch(`${base}/api/events?jobId=${scan.jobId}`);
    const text = await res.text();
    assert.match(text, /"type":"done"/);
    assert.match(text, /dedup-removed/);
  });

  await fs.access(path.join(root, '_trash', 'b.jpg'));
  await fs.rm(root, { recursive: true });
});

test('POST /api/run 拒绝未知 jobId', async () => {
  await withServer(async (base) => {
    const res = await postJson(base, '/api/run', { jobId: 'nope', options: {} });
    assert.equal(res.status, 400);
  });
});

test('GET / 返回页面', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

test('静态文件路由拒绝目录穿越', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/../package.json`);
    assert.ok(res.status === 403 || res.status === 404, `status=${res.status}`);
  });
});
