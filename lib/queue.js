export async function runQueue(tasks, concurrency) {
  const results = new Array(tasks.length).fill(null);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]();
      } catch {
        results[index] = null;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
