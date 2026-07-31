import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.js';
import { parseFps, targetSize, needsCompress, FPS_LIMIT } from './video-rules.js';

export function parseProgressTime(chunk) {
  const m = chunk.match(/time=(\d+):(\d{2}):(\d{2}\.\d+)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export async function probeVideo(filePath) {
  const { code, stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', filePath,
  ]);
  if (code !== 0) throw new Error('ffprobe 无法读取该文件');

  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((s) => s.codec_type === 'video');
  if (!video) throw new Error('文件中没有视频轨');

  const duration = Number(data.format?.duration) || Number(video.duration) || 0;
  const size = Number(data.format?.size) || 0;

  // 部分容器（如 mkv）不写 format.bit_rate，退回按体积与时长估算
  let bitrate = Number(data.format?.bit_rate) || null;
  if (!bitrate && duration > 0 && size > 0) {
    bitrate = Math.round((size * 8) / duration);
  }

  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps: parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate) ?? 0,
    bitrate,
    duration,
    codec: video.codec_name || '',
  };
}

export function buildFfmpegArgs(input, output, info, encoder) {
  const args = ['-hide_banner', '-nostdin', '-i', input];
  const size = targetSize(info.width, info.height);

  args.push('-c:v', encoder, '-tag:v', 'hvc1');
  args.push('-b:v', '2M', '-maxrate', '3M', '-bufsize', '4M');

  if (size.width !== info.width || size.height !== info.height) {
    args.push('-vf', `scale=${size.width}:${size.height}`);
  }
  if (Number.isFinite(info.fps) && info.fps > FPS_LIMIT) {
    args.push('-r', '30');
  }

  args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-map_metadata', '0', '-movflags', '+faststart');
  args.push('-y', output);
  return args;
}

async function pickOutputPath(item) {
  const dir = path.dirname(item.path);
  const stem = path.basename(item.path, path.extname(item.path));
  const preferred = path.join(dir, `${stem}.mp4`);
  if (preferred === item.path) return preferred;
  try {
    await fs.access(preferred);
    return path.join(dir, `${stem}-h265.mp4`);
  } catch {
    return preferred;
  }
}

export async function processVideo(item, { trash, encoder, onProgress }) {
  const base = { rel: item.rel, from: item.path, to: null, before: item.size, after: item.size };

  let info;
  try {
    info = await probeVideo(item.path);
  } catch (err) {
    return { ...base, action: 'error', error: err.message };
  }

  const reasons = needsCompress(info);
  if (reasons.length === 0) {
    return { ...base, action: 'skipped', note: '已达标' };
  }

  const dir = path.dirname(item.path);
  const stem = path.basename(item.path, path.extname(item.path));
  const tmp = path.join(dir, `.${stem}.__tmp.mp4`);

  try {
    const args = buildFfmpegArgs(item.path, tmp, info, encoder);
    const { code, stderr } = await run('ffmpeg', args, {
      onStderr: (chunk) => {
        const seconds = parseProgressTime(chunk);
        if (seconds != null && info.duration > 0) {
          onProgress?.(Math.min(1, seconds / info.duration));
        }
      },
    });
    if (code !== 0) throw new Error(stderr.trim().split('\n').slice(-3).join(' '));

    const outSize = (await fs.stat(tmp)).size;

    // 安全阀：压完反而更大就放弃，保留原件
    if (outSize >= item.size) {
      await fs.rm(tmp, { force: true });
      return { ...base, action: 'skipped', note: '压缩无收益' };
    }

    const finalPath = await pickOutputPath(item);
    await trash.move(item.path, 'video-compressed');
    await fs.rename(tmp, finalPath);
    const t = new Date(item.mtime);
    await fs.utimes(finalPath, t, t);

    return { ...base, action: 'video-compressed', to: finalPath, after: outSize, reasons };
  } catch (err) {
    await fs.rm(tmp, { force: true });
    return { ...base, action: 'error', error: err.message };
  }
}
