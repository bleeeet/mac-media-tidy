import { scanFolder } from './scan.js';
import { findDuplicates } from './dedup.js';
import { planImage } from './image.js';
import { probeVideo } from './video.js';
import { needsCompress, MAX_IMAGE_BYTES, MIN_VIDEO_BYTES } from './video-rules.js';
import { runQueue } from './queue.js';
import { Ledger } from './ledger.js';

const TARGET_BITS_PER_SECOND = 2_000_000 + 128_000;

export function estimateSaving(plan) {
  let saving = 0;
  for (const group of plan.dupGroups) {
    saving += group.size * group.remove.length;
  }
  for (const task of plan.videoTasks) {
    const projected = (task.info.duration * TARGET_BITS_PER_SECOND) / 8;
    saving += Math.max(0, task.item.size - projected);
  }
  for (const task of plan.imageTasks) {
    if (task.decision.compress) {
      saving += Math.max(0, task.item.size - MAX_IMAGE_BYTES);
    }
  }
  return Math.round(saving);
}

export async function buildPlan(rootDir, onProgress) {
  onProgress?.({ phase: 'scan', message: '正在扫描文件夹…' });
  const { images, videos } = await scanFolder(rootDir);

  const ledger = new Ledger(rootDir);
  await ledger.load();
  const processed = (item) => ledger.has(item.rel, item.size, item.mtime);
  let skippedCount = 0;

  onProgress?.({ phase: 'dedup', message: '正在比对重复文件…' });
  const dupGroups = await findDuplicates([...images, ...videos], (done, total) => {
    onProgress?.({ phase: 'dedup', done, total });
  });

  // 将被删除的重复项不必再参与转换与压制
  const doomed = new Set();
  for (const group of dupGroups) {
    for (const item of group.remove) doomed.add(item.path);
  }

  const imageTasks = [];
  for (const item of images) {
    if (doomed.has(item.path)) continue;
    // 本工具压过/转过的文件不再碰，否则每次运行都会再有损编码一轮
    if (processed(item)) {
      skippedCount += 1;
      continue;
    }
    const decision = planImage(item);
    if (decision.convert || decision.compress) imageTasks.push({ item, decision });
  }

  onProgress?.({ phase: 'probe', message: '正在分析视频参数…' });
  // 已处理过的视频连 ffprobe 都免了，重复扫描同一个文件夹会快很多
  const survivors = videos.filter((v) => {
    if (doomed.has(v.path)) return false;
    if (v.size < MIN_VIDEO_BYTES) return false;
    if (processed(v)) {
      skippedCount += 1;
      return false;
    }
    return true;
  });
  let probed = 0;
  const probeResults = await runQueue(
    survivors.map((item) => async () => {
      const info = await probeVideo(item.path);
      probed += 1;
      onProgress?.({ phase: 'probe', done: probed, total: survivors.length });
      return { item, info, reasons: needsCompress(info) };
    }),
    4
  );

  const videoTasks = probeResults.filter((r) => r && r.reasons.length > 0);

  const plan = { root: rootDir, dupGroups, imageTasks, videoTasks };
  plan.stats = {
    imageCount: images.length,
    videoCount: videos.length,
    dupCount: dupGroups.reduce((n, g) => n + g.remove.length, 0),
    dupBytes: dupGroups.reduce((n, g) => n + g.size * g.remove.length, 0),
    heicCount: imageTasks.filter((t) => t.decision.convert).length,
    imageCompressCount: imageTasks.filter((t) => t.decision.compress).length,
    videoCompressCount: videoTasks.length,
    skippedCount,
    estimatedSaving: estimateSaving(plan),
  };
  return plan;
}
