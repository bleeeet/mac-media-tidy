import fs from 'node:fs/promises';
import path from 'node:path';

export const IMAGE_FULL = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'tiff', 'tif']);
export const IMAGE_DEDUP_ONLY = new Set(['webp', 'gif', 'bmp']);
export const VIDEO_EXTS = new Set([
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', '3gp',
]);

export const TRASH_DIR = '_trash';

export function isProcessableImage(ext) {
  return IMAGE_FULL.has(ext.toLowerCase());
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export async function scanFolder(rootDir) {
  const images = [];
  const videos = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(rootDir, full) === TRASH_DIR) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extOf(entry.name);
      const isImage = IMAGE_FULL.has(ext) || IMAGE_DEDUP_ONLY.has(ext);
      const isVideo = VIDEO_EXTS.has(ext);
      if (!isImage && !isVideo) continue;
      const stat = await fs.stat(full);
      const item = {
        path: full,
        rel: path.relative(rootDir, full),
        size: stat.size,
        mtime: stat.mtimeMs,
        ext,
      };
      (isImage ? images : videos).push(item);
    }
  }

  await walk(rootDir);
  images.sort((a, b) => a.rel.localeCompare(b.rel));
  videos.sort((a, b) => a.rel.localeCompare(b.rel));
  return { images, videos };
}
