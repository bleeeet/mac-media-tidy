import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBackupDir, MANIFEST_FILE } from './scan.js';

export class Trash {
  constructor(rootDir, { backup = true } = {}) {
    this.rootDir = rootDir;
    this.backup = backup;
    this.trashDir = null;
    this.manifestPath = null;
    this.entries = [];
  }

  // 备份目录名要看盘上现状才能定，因此不能在构造函数里算
  async #ensureDir() {
    if (this.trashDir || !this.backup) return;
    this.trashDir = await resolveBackupDir(this.rootDir);
    this.manifestPath = path.join(this.trashDir, MANIFEST_FILE);
  }

  async load() {
    await this.#ensureDir();
    if (!this.backup) return;
    try {
      const raw = await fs.readFile(this.manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.entries = parsed;
    } catch {
      this.entries = [];
    }
  }

  async #freeTarget(rel) {
    const dir = path.join(this.trashDir, path.dirname(rel));
    const ext = path.extname(rel);
    const base = path.basename(rel, ext);
    let candidate = path.join(dir, base + ext);
    let n = 0;
    while (true) {
      try {
        await fs.access(candidate);
        n += 1;
        candidate = path.join(dir, `${base}-${n}${ext}`);
      } catch {
        return candidate;
      }
    }
  }

  async move(filePath, reason) {
    await this.#ensureDir();

    // 关掉备份就是真删除，没有可回滚的东西，也就不必写 manifest
    if (!this.backup) {
      await fs.rm(filePath, { force: true });
      return { from: filePath, to: null };
    }

    const rel = path.relative(this.rootDir, filePath);
    const target = await this.#freeTarget(rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(filePath, target);
    this.entries.push({
      action: 'trash',
      from: filePath,
      to: target,
      reason,
      ts: Date.now(),
    });
    await this.#save();
    return { from: filePath, to: target };
  }

  async #save() {
    await fs.mkdir(this.trashDir, { recursive: true });
    await fs.writeFile(this.manifestPath, JSON.stringify(this.entries, null, 2));
  }
}
