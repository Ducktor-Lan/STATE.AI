import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, DEFAULT_PORT, installShutdown } from './server.js';
export { createServer, startServer, DEFAULT_PORT } from './server.js';
export { RunManager } from './runs.js';
export { TournamentManager } from './tournaments.js';
export { MediaManager } from './media.js';
export type * from './types.js';

export async function serverMain(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('STATE.AI local server\nUsage: node dist/server.mjs [--port 4180] [--root DIRECTORY] [--data-dir DIRECTORY] [--models FILE]\nBinds only 127.0.0.1. Defaults: cwd, runs/, configs/models.local.json then models.default.json then models.example.json.'); return;
  }
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !['--port', '--root', '--data-dir', '--models'].includes(key) || !value || value.startsWith('--')) throw new Error('Unknown or incomplete server option. Use --help.');
    values[key] = value;
  }
  const requested = values['--port'];
  if (requested !== undefined && !/^\d+$/u.test(requested)) throw new Error('Port must be an integer.');
  const app = await startServer({ rootDir: values['--root'] ? resolve(values['--root']) : process.cwd(), ...(requested !== undefined ? { port: Number(requested) } : {}),
    ...(values['--data-dir'] ? { dataDir: resolve(values['--data-dir']) } : {}), ...(values['--models'] ? { configPath: resolve(values['--models']) } : {}) });
  console.log(`STATE.AI listening at ${app.url}`); installShutdown(app);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void serverMain().catch(error => { console.error(error instanceof Error ? error.message : 'Server failed.'); process.exitCode = 1; });
}
