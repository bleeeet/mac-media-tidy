import fs from 'node:fs/promises';
import path from 'node:path';
import { TRASH_DIR } from './scan.js';

export class Trash {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.trashDir = path.join(rootDir, TRASH_DIR);
    this.manifestPath = path.join(this.trashDir, 'manifest.json');
    this.entries = [];
  }

  async load() {
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
