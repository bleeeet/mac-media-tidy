import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { runQueue } from './queue.js';

export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function pickKeeper(items) {
  return [...items].sort(
    (a, b) => a.mtime - b.mtime || a.rel.localeCompare(b.rel)
  )[0];
}

export async function findDuplicates(items, onProgress) {
  const bySize = new Map();
  for (const item of items) {
    if (!bySize.has(item.size)) bySize.set(item.size, []);
    bySize.get(item.size).push(item);
  }

  const candidates = [...bySize.values()].filter((g) => g.length > 1).flat();
  let done = 0;
  const tasks = candidates.map((item) => async () => {
    const hash = await hashFile(item.path);
    done += 1;
    onProgress?.(done, candidates.length);
    return { item, hash };
  });

  const hashed = await runQueue(tasks, 8);

  const byHash = new Map();
  for (const entry of hashed) {
    if (!entry) continue;
    if (!byHash.has(entry.hash)) byHash.set(entry.hash, []);
    byHash.get(entry.hash).push(entry.item);
  }

  const groups = [];
  for (const [hash, members] of byHash) {
    if (members.length < 2) continue;
    const keep = pickKeeper(members);
    groups.push({
      hash,
      size: keep.size,
      keep,
      remove: members.filter((m) => m !== keep),
    });
  }
  return groups;
}
