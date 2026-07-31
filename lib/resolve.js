import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function searchRoots() {
  const home = os.homedir();
  return ['Downloads', 'Desktop', 'Pictures', 'Documents', 'Movies'].map((d) =>
    path.join(home, d)
  );
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 用户可能从终端拖入（空格被转义成 "\ "）或带着引号粘贴
function cleanPath(raw) {
  let p = (raw || '').trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  return expandHome(p);
}

export async function matchScore(dirPath, samples) {
  let score = 0;
  for (const sample of samples) {
    try {
      const stat = await fs.stat(path.join(dirPath, sample.name));
      if (stat.isFile() && stat.size === sample.size) score += 1;
    } catch {
      // 样本不在此目录，不计分
    }
  }
  return score;
}

async function subdirs(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(dirPath, e.name));
  } catch {
    return [];
  }
}

export async function resolveFolder(folderName, samples = []) {
  const candidates = [];
  for (const root of searchRoots()) {
    if (path.basename(root) === folderName) candidates.push(root);
    for (const dir of await subdirs(root)) {
      if (path.basename(dir) === folderName) candidates.push(dir);
      for (const nested of await subdirs(dir)) {
        if (path.basename(nested) === folderName) candidates.push(nested);
      }
    }
  }

  const scored = [];
  for (const dir of candidates) {
    scored.push({ path: dir, score: await matchScore(dir, samples) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.path);
}

export async function listDirs(dirPath) {
  const target = cleanPath(dirPath || '~');
  const entries = await fs.readdir(target, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, dirs };
}

export async function validateFolder(raw) {
  const primary = cleanPath(raw);
  if (!primary) return { ok: false, error: '路径为空' };

  // 先按原样解析；不成再把终端风格的 "\ " 转义还原为普通空格
  const attempts = [primary];
  if (primary.includes('\\')) attempts.push(primary.replace(/\\(.)/g, '$1'));

  for (const candidate of attempts) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isDirectory()) return { ok: false, error: '这不是一个文件夹' };
      return { ok: true, path: path.resolve(candidate) };
    } catch {
      // 试下一种写法
    }
  }
  return { ok: false, error: '路径不存在' };
}
