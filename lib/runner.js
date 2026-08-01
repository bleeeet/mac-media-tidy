import os from 'node:os';
import fs from 'node:fs/promises';
import { Trash } from './trash.js';
import { listToolBackupDirs } from './scan.js';
import { Ledger } from './ledger.js';
import { runQueue } from './queue.js';
import { processImage } from './image.js';
import { processVideo } from './video.js';

const VIDEO_CONCURRENCY = 4;
const REWRITTEN = new Set(['image-compressed', 'heic-converted', 'video-compressed']);

// HEIC 转 JPG 会让文件变大（HEIC 压缩效率约为 JPEG 的两倍），
// 这类负收益必须如实计入，否则报告出来的"节省"会偏乐观。
export function sumSaved(results) {
  return results.reduce(
    (sum, r) => sum + (r.action === 'error' ? 0 : r.before - r.after),
    0
  );
}

export async function runPlan(plan, options, emit) {
  const {
    dedup = true,
    heic = true,
    imageCompress = true,
    videoCompress = true,
    backup = true,
    encoder = 'hevc_videotoolbox',
  } = options;

  const trash = new Trash(plan.root, { backup });
  await trash.load();
  const ledger = new Ledger(plan.root);
  await ledger.load();
  const results = [];

  // 「压了但产物更大、已丢弃」的文件也要记：不记的话每次运行都会白压一遍，视频尤其贵
  const remember = async (result) => {
    let action = null;
    if (REWRITTEN.has(result.action)) action = result.action;
    else if (result.action === 'skipped' && result.note === '压缩无收益') action = 'no-gain';
    if (!action) return;
    try {
      await ledger.record(result.to || result.from, action);
    } catch {
      // 记录写失败只影响下次会重做一遍，不该中断本次处理
    }
  };

  const record = async (result) => {
    results.push(result);
    emit({ type: 'item', ...result });
    await remember(result);
  };

  if (dedup && plan.dupGroups.length > 0) {
    emit({ type: 'phase', phase: 'dedup', message: '正在清理重复文件…' });
    for (const group of plan.dupGroups) {
      for (const item of group.remove) {
        try {
          await trash.move(item.path, 'duplicate');
          await record({
            rel: item.rel, action: 'dedup-removed',
            from: item.path, to: null, before: item.size, after: 0,
          });
        } catch (err) {
          await record({
            rel: item.rel, action: 'error', from: item.path, to: null,
            before: item.size, after: item.size, error: err.message,
          });
        }
      }
    }
  }

  const imageTasks = plan.imageTasks.filter(
    (t) => (t.decision.convert && heic) || (t.decision.compress && imageCompress)
  );
  if (imageTasks.length > 0) {
    emit({ type: 'phase', phase: 'image', message: `正在处理 ${imageTasks.length} 张图片…` });
    await runQueue(
      imageTasks.map((task) => async () => {
        await record(await processImage(task.item, { trash, imageCompress }));
      }),
      Math.max(2, os.cpus().length)
    );
  }

  if (videoCompress && plan.videoTasks.length > 0) {
    emit({ type: 'phase', phase: 'video', message: `正在压制 ${plan.videoTasks.length} 个视频…` });
    await runQueue(
      plan.videoTasks.map((task) => async () => {
        await record(await processVideo(task.item, {
          trash,
          encoder,
          onProgress: (ratio) => emit({ type: 'video-progress', rel: task.item.rel, ratio }),
        }));
      }),
      VIDEO_CONCURRENCY
    );
  }

  // 关掉备份就不该在文件夹里留下任何备份目录，上次跑留下的一并清掉。
  // 放在处理之后：中途出错时旧备份还在，仍有回滚的余地。
  const removedBackups = [];
  if (!backup) {
    for (const dir of await listToolBackupDirs(plan.root)) {
      await fs.rm(dir, { recursive: true, force: true });
      removedBackups.push(dir);
    }
  }

  const report = {
    results,
    errors: results.filter((r) => r.action === 'error'),
    savedBytes: sumSaved(results),
    trashDir: trash.trashDir,
    removedBackups,
  };
  emit({ type: 'done', report });
  return report;
}
