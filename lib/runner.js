import os from 'node:os';
import { Trash } from './trash.js';
import { runQueue } from './queue.js';
import { processImage } from './image.js';
import { processVideo } from './video.js';

const VIDEO_CONCURRENCY = 4;

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
    encoder = 'hevc_videotoolbox',
  } = options;

  const trash = new Trash(plan.root);
  await trash.load();
  const results = [];

  const record = (result) => {
    results.push(result);
    emit({ type: 'item', ...result });
  };

  if (dedup && plan.dupGroups.length > 0) {
    emit({ type: 'phase', phase: 'dedup', message: '正在清理重复文件…' });
    for (const group of plan.dupGroups) {
      for (const item of group.remove) {
        try {
          await trash.move(item.path, 'duplicate');
          record({
            rel: item.rel, action: 'dedup-removed',
            from: item.path, to: null, before: item.size, after: 0,
          });
        } catch (err) {
          record({
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
        record(await processImage(task.item, { trash }));
      }),
      Math.max(2, os.cpus().length)
    );
  }

  if (videoCompress && plan.videoTasks.length > 0) {
    emit({ type: 'phase', phase: 'video', message: `正在压制 ${plan.videoTasks.length} 个视频…` });
    await runQueue(
      plan.videoTasks.map((task) => async () => {
        record(await processVideo(task.item, {
          trash,
          encoder,
          onProgress: (ratio) => emit({ type: 'video-progress', rel: task.item.rel, ratio }),
        }));
      }),
      VIDEO_CONCURRENCY
    );
  }

  const report = {
    results,
    errors: results.filter((r) => r.action === 'error'),
    savedBytes: sumSaved(results),
    trashDir: trash.trashDir,
  };
  emit({ type: 'done', report });
  return report;
}
