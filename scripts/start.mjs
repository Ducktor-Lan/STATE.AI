import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'dist', 'server.mjs');

try {
  await access(entry);
} catch {
  console.error('[start] Missing dist/server.mjs. Implement apps/server/src/main.ts and run npm run build.');
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(`[start] ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
