import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildPlan } from './lib/plan.js';
import { runPlan } from './lib/runner.js';
import { resolveFolder, listDirs, validateFolder } from './lib/resolve.js';
import { run, commandExists } from './lib/exec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.PORT) || 7788;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// jobId -> {plan, listeners: Set<res>, buffer: [], finished, started}
const jobs = new Map();

let healthCache = null;
async function detectHealth() {
  if (healthCache) return healthCache;
  const [ffmpeg, ffprobe, sips] = await Promise.all([
    commandExists('ffmpeg'),
    commandExists('ffprobe'),
    commandExists('sips'),
  ]);
  let videotoolbox = false;
  let encoder = 'none';
  if (ffmpeg) {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders']);
    videotoolbox = stdout.includes('hevc_videotoolbox');
    encoder = videotoolbox
      ? 'hevc_videotoolbox'
      : stdout.includes('libx265')
        ? 'libx265'
        : 'none';
  }
  healthCache = { ffmpeg, ffprobe, sips, videotoolbox, encoder };
  return healthCache;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 计划对象含大量内部字段，序列化时裁剪为界面所需
function serializePlan(plan) {
  return {
    root: plan.root,
    stats: plan.stats,
    duplicates: plan.dupGroups.map((g) => ({
      keep: g.keep.rel,
      remove: g.remove.map((i) => i.rel),
      size: g.size,
    })),
    images: plan.imageTasks.map((t) => ({
      rel: t.item.rel, size: t.item.size, ...t.decision,
    })),
    videos: plan.videoTasks.map((t) => ({
      rel: t.item.rel, size: t.item.size,
      width: t.info.width, height: t.info.height,
      fps: Math.round(t.info.fps * 100) / 100,
      bitrate: t.info.bitrate, duration: t.info.duration,
      reasons: t.reasons,
    })),
  };
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    return json(res, 200, await detectHealth());
  }

  if (url.pathname === '/api/ls') {
    try {
      return json(res, 200, await listDirs(url.searchParams.get('path') || '~'));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (req.method !== 'POST') return json(res, 404, { error: '未知接口' });

  const body = await readBody(req);

  if (url.pathname === '/api/validate') {
    return json(res, 200, await validateFolder(body.path));
  }

  if (url.pathname === '/api/resolve') {
    const candidates = await resolveFolder(body.folderName || '', body.samples || []);
    return json(res, 200, { candidates });
  }

  if (url.pathname === '/api/scan') {
    const check = await validateFolder(body.path);
    if (!check.ok) return json(res, 400, { error: check.error });
    const plan = await buildPlan(check.path);
    const jobId = randomUUID();
    jobs.set(jobId, { plan, listeners: new Set(), buffer: [], finished: false, started: false });
    return json(res, 200, { jobId, ...serializePlan(plan) });
  }

  if (url.pathname === '/api/run') {
    const job = jobs.get(body.jobId);
    if (!job) return json(res, 400, { error: '任务不存在，请重新扫描' });
    if (job.started) return json(res, 400, { error: '任务已在运行' });
    job.started = true;

    const { encoder } = await detectHealth();
    const emit = (event) => {
      job.buffer.push(event);
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const listener of job.listeners) listener.write(line);
      if (event.type === 'done') {
        job.finished = true;
        for (const listener of job.listeners) listener.end();
        job.listeners.clear();
      }
    };

    // 不等待：处理在后台继续，进度通过 SSE 推送
    runPlan(job.plan, { ...body.options, encoder }, emit).catch((err) => {
      emit({
        type: 'done',
        report: { results: [], errors: [{ error: err.message }], savedBytes: 0 },
      });
    });

    return json(res, 200, { jobId: body.jobId });
  }

  return json(res, 404, { error: '未知接口' });
}

function handleEvents(req, res, url) {
  const job = jobs.get(url.searchParams.get('jobId'));
  if (!job) return json(res, 404, { error: '任务不存在' });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // 重连时补发已发生的事件，关掉页面再打开也能接上
  for (const event of job.buffer) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (job.finished) return res.end();

  job.listeners.add(res);
  req.on('close', () => job.listeners.delete(res));
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) {
    return json(res, 403, { error: '禁止访问' });
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    });
    res.end(data);
  } catch {
    json(res, 404, { error: '文件不存在' });
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === '/api/events') return handleEvents(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await serveStatic(res, url.pathname);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`媒体整理工具已启动：http://127.0.0.1:${PORT}`);
  });
}
