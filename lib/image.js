import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.js';
import { MAX_IMAGE_BYTES } from './video-rules.js';
import { isProcessableImage } from './scan.js';

const CONVERT_EXTS = new Set(['heic', 'heif']);
const MAX_DIMENSION = 4000;

export function qualityLadder() {
  return [85, 75, 65, 55];
}

// 带 alpha 的 PNG 不能转 JPG，只能靠缩尺寸减重，因此需要一个逐级下探的档位表
export function dimensionLadder(longestEdge) {
  const ladder = [4000, 3000, 2000, 1500].filter((d) => d < longestEdge);
  return ladder.length > 0 ? ladder : [longestEdge];
}

export function planImage(item) {
  if (!isProcessableImage(item.ext)) {
    return { convert: false, compress: false };
  }
  return {
    convert: CONVERT_EXTS.has(item.ext.toLowerCase()),
    compress: item.size > MAX_IMAGE_BYTES,
  };
}

export async function probeImage(filePath) {
  const { stdout } = await run('sips', [
    '-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', '-g', 'format',
    filePath,
  ]);
  const get = (key) => {
    const m = stdout.match(new RegExp(`${key}:\\s*(\\S+)`));
    return m ? m[1] : null;
  };
  return {
    width: Number(get('pixelWidth')) || 0,
    height: Number(get('pixelHeight')) || 0,
    hasAlpha: get('hasAlpha') === 'yes',
    format: get('format') || '',
  };
}

async function encodeJpeg(src, dest, quality, maxDim) {
  const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality)];
  if (maxDim) args.push('-Z', String(maxDim));
  args.push(src, '--out', dest);
  const { code, stderr } = await run('sips', args);
  if (code !== 0) throw new Error(`sips 失败: ${stderr.trim()}`);
  return (await fs.stat(dest)).size;
}

async function shrinkPng(src, dest, maxDim) {
  const { code, stderr } = await run('sips', ['-Z', String(maxDim), src, '--out', dest]);
  if (code !== 0) throw new Error(`sips 失败: ${stderr.trim()}`);
  return (await fs.stat(dest)).size;
}

async function restoreTimes(filePath, mtimeMs) {
  const t = new Date(mtimeMs);
  await fs.utimes(filePath, t, t);
}

export async function processImage(item, { trash }) {
  const base = {
    rel: item.rel, from: item.path, to: null,
    before: item.size, after: item.size,
  };
  const decision = planImage(item);
  if (!decision.convert && !decision.compress) {
    return { ...base, action: 'skipped' };
  }

  const dir = path.dirname(item.path);
  const stem = path.basename(item.path, path.extname(item.path));
  const tmp = path.join(dir, `.${stem}.__tmp`);

  try {
    const info = await probeImage(item.path);
    const keepPng = item.ext.toLowerCase() === 'png' && info.hasAlpha;
    const maxDim = Math.max(info.width, info.height) > MAX_DIMENSION ? MAX_DIMENSION : null;

    let outPath;
    let outSize;

    if (keepPng) {
      // 有透明通道：保持 PNG，只能靠缩尺寸减重，逐级下探直到达标
      const tmpPng = `${tmp}.png`;
      for (const dim of dimensionLadder(Math.max(info.width, info.height))) {
        outSize = await shrinkPng(item.path, tmpPng, dim);
        if (outSize <= MAX_IMAGE_BYTES) break;
      }
      outPath = tmpPng;
    } else {
      const tmpJpg = `${tmp}.jpg`;
      if (!decision.compress) {
        // 仅格式转换，不必压缩
        outSize = await encodeJpeg(item.path, tmpJpg, 85, null);
      } else {
        // 每一档都从原始文件重新编码，避免有损叠加
        for (const quality of qualityLadder()) {
          outSize = await encodeJpeg(item.path, tmpJpg, quality, maxDim);
          if (outSize <= MAX_IMAGE_BYTES) break;
        }
      }
      outPath = tmpJpg;
    }

    // 安全阀：不需要格式转换、压缩又没有收益时放弃
    if (!decision.convert && outSize >= item.size) {
      await fs.rm(outPath, { force: true });
      return { ...base, action: 'skipped', note: '压缩无收益' };
    }

    const finalExt = keepPng ? '.png' : '.jpg';
    const finalPath = path.join(dir, stem + finalExt);

    // 原文件先入回收站（同名场景下必须先腾位置）
    await trash.move(item.path, decision.convert ? 'heic-converted' : 'image-compressed');
    await fs.rename(outPath, finalPath);
    await restoreTimes(finalPath, item.mtime);

    return {
      ...base,
      action: decision.convert ? 'heic-converted' : 'image-compressed',
      to: finalPath,
      after: outSize,
    };
  } catch (err) {
    await fs.rm(`${tmp}.jpg`, { force: true });
    await fs.rm(`${tmp}.png`, { force: true });
    return { ...base, action: 'error', error: err.message };
  }
}
