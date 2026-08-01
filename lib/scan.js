import fs from 'node:fs/promises';
import path from 'node:path';

export const IMAGE_FULL = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'tiff', 'tif']);
export const IMAGE_DEDUP_ONLY = new Set(['webp', 'gif', 'bmp']);
export const VIDEO_EXTS = new Set([
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', '3gp',
]);

export const BACKUP_DIR = '原图';
export const BACKUP_DIR_ALT = '原图-备份';
export const LEGACY_TRASH_DIR = '_trash';
export const MANIFEST_FILE = 'manifest.json';

export function isProcessableImage(ext) {
  return IMAGE_FULL.has(ext.toLowerCase());
}

// 「原图」是中文用户给自己照片目录起的常见名字。只有里面躺着 manifest.json 才认作
// 本工具的备份目录；否则退让到「原图-备份」，免得把用户自己的照片圈进备份区不再处理。
export async function resolveBackupDir(rootDir) {
  const primary = path.join(rootDir, BACKUP_DIR);
  try {
    await fs.access(path.join(primary, MANIFEST_FILE));
    return primary;
  } catch {
    // 没有 manifest，继续判断这个目录到底存不存在
  }
  try {
    await fs.access(primary);
    return path.join(rootDir, BACKUP_DIR_ALT);
  } catch {
    return primary;
  }
}

// 列出本工具建过的备份目录。只认里面有 manifest.json 的，
// 否则会把用户自己那个叫「原图」的文件夹当成自己的东西清掉。
export async function listToolBackupDirs(rootDir) {
  const found = [];
  for (const name of [BACKUP_DIR, BACKUP_DIR_ALT, LEGACY_TRASH_DIR]) {
    const dir = path.join(rootDir, name);
    try {
      await fs.access(path.join(dir, MANIFEST_FILE));
      found.push(dir);
    } catch {
      // 没有 manifest 就不是本工具的，跳过
    }
  }
  return found;
}

async function backupDirsToSkip(rootDir) {
  // _trash 是旧版本留下的备份目录，仍要跳过，否则回收站里的原件会被当成素材重新处理
  const skip = new Set([LEGACY_TRASH_DIR, BACKUP_DIR_ALT]);
  const backupDir = await resolveBackupDir(rootDir);
  if (path.basename(backupDir) === BACKUP_DIR) skip.add(BACKUP_DIR);
  return skip;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export async function scanFolder(rootDir) {
  const images = [];
  const videos = [];
  const skipDirs = await backupDirsToSkip(rootDir);

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(path.relative(rootDir, full))) continue;
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
