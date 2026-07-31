import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const html = await fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8');
const appJs = await fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8');

function htmlIds() {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

test('app.js 引用的每个元素 id 都存在于 index.html', () => {
  const declared = htmlIds();
  const referenced = [...appJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(referenced)].filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `app.js 引用了不存在的 id: ${missing.join(', ')}`);
});

test('index.html 里的四个开关都被 app.js 读取', () => {
  for (const id of ['optDedup', 'optHeic', 'optImage', 'optVideo']) {
    assert.ok(htmlIds().has(id), `index.html 缺少开关 ${id}`);
    assert.ok(appJs.includes(`$('${id}')`), `app.js 未读取开关 ${id}`);
  }
});

test('app.js 是合法的 ES 模块', async () => {
  // 用 data URL 做一次语法解析；引用 document 的代码不会执行到，解析失败才会抛错
  await assert.doesNotReject(async () => {
    new Function(`return import(${JSON.stringify(
      'data:text/javascript,' + encodeURIComponent(appJs)
    )})`);
  });
});

test('index.html 引用的静态资源都存在', async () => {
  const refs = [...html.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, '页面应引用 app.js 与 style.css');
  for (const ref of refs) {
    await fs.access(path.join(PUBLIC, ref));
  }
});

test('前端发出的接口路径都由 server.js 处理', async () => {
  const server = await fs.readFile(
    path.join(PUBLIC, '..', 'server.js'),
    'utf8'
  );
  const routes = new Set(
    [...appJs.matchAll(/['"`](\/api\/[a-z]+)/g)].map((m) => m[1])
  );
  assert.ok(routes.size >= 5, `只发现 ${routes.size} 个接口调用`);
  for (const route of routes) {
    assert.ok(server.includes(`'${route}'`), `server.js 未处理 ${route}`);
  }
});

test('用户可见的文本片段都做了 HTML 转义', () => {
  // 文件名可能含 < > &，直接拼进 innerHTML 会破坏页面结构
  const interpolations = [...appJs.matchAll(/innerHTML\s*=\s*([\s\S]*?);\n/g)];
  assert.ok(interpolations.length > 0);
  for (const [, expr] of interpolations) {
    const rawVars = [...expr.matchAll(/\$\{(?!esc\(|fmtBytes\(|Math\.)([^}]+)\}/g)];
    const suspicious = rawVars
      .map((m) => m[1].trim())
      // 数字、数组长度与内部常量不构成注入风险
      .filter((v) => !/^(n|s\.\w+|cls|label|prog|\d+|[\w.]+\.length)$/.test(v));
    assert.deepEqual(suspicious, [], `未转义的插值: ${suspicious.join(', ')}`);
  }
});
