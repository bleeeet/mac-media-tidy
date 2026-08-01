import fs from 'node:fs/promises';
import path from 'node:path';

export const LEDGER_FILE = '.media-kit.json';

// 记录本工具压过、转过的文件，避免下次运行重来一遍造成有损叠加。
// 放在目标文件夹根部而不是 _trash/manifest.json 里，因为回收站是鼓励用户删掉的。
export class Ledger {
  #writes = Promise.resolve();

  constructor(rootDir) {
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, LEDGER_FILE);
    this.files = {};
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (parsed && typeof parsed.files === 'object' && parsed.files !== null) {
        this.files = parsed.files;
      }
    } catch {
      this.files = {};
    }
  }

  // 体积或修改时间对不上，说明文件在本工具之外被改动过，记录作废、重新评估
  has(rel, size, mtime) {
    const hit = this.files[rel];
    return Boolean(hit) && hit.size === size && hit.mtime === Math.round(mtime);
  }

  async record(filePath, action) {
    const stat = await fs.stat(filePath);
    const rel = path.relative(this.rootDir, filePath);
    this.files[rel] = { size: stat.size, mtime: Math.round(stat.mtimeMs), action };
    return this.#save();
  }

  // 图片处理是并发的，写盘必须排队，否则两个 writeFile 会把临时文件写花
  #save() {
    this.#writes = this.#writes.then(() => this.#write());
    return this.#writes;
  }

  async #write() {
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, files: this.files }, null, 2));
    await fs.rename(tmp, this.filePath);
  }
}
