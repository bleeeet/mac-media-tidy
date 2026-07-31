import { spawn } from 'node:child_process';

export function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      onStderr?.(text);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function commandExists(cmd) {
  const { code } = await run('which', [cmd]);
  return code === 0;
}
