import { spawn } from 'node:child_process';
import { buildProject, root } from './build.mjs';

let contexts = [];
try {
  contexts = await buildProject({ watch: true });
  const child = spawn(process.execPath, ['--watch', 'dist/server.mjs', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
  });
  let stopping = false;
  const stop = async (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
    await Promise.all(contexts.map((context) => context.dispose()));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void stop(signal));
  }
  child.on('error', (error) => {
    console.error(`[dev] ${error.message}`);
    process.exitCode = 1;
    void stop();
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
    void stop();
  });
} catch (error) {
  console.error(`[dev] ${error.message}`);
  await Promise.all(contexts.map((context) => context.dispose()));
  process.exitCode = 1;
}
