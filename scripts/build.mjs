import { build, context } from 'esbuild';
import { access, copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsconfig = join(root, 'tsconfig.json');
const targets = [
  { name: 'server', entry: 'apps/server/src/main.ts', output: 'dist/server.mjs' },
  { name: 'cli', entry: 'apps/cli/src/main.ts', output: 'dist/cli.mjs' },
  { name: 'web', entry: 'apps/web/src/main.ts', output: 'dist/web/app.js' },
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyWebAssets() {
  const html = join(root, 'apps/web/index.html');
  const output = join(root, 'dist/web');
  if (!(await exists(html))) throw new Error('Missing apps/web/index.html (references ./app.js and ./styles.css).');
  await mkdir(output, { recursive: true });
  await copyFile(html, join(output, 'index.html'));
  const bundledCss = join(output, 'app.css');
  const sourceCss = join(root, 'apps/web/src/styles.css');
  if (await exists(bundledCss)) {
    await rename(bundledCss, join(output, 'styles.css'));
  } else if (await exists(sourceCss)) {
    await copyFile(sourceCss, join(output, 'styles.css'));
  } else {
    throw new Error('Missing web styles: import CSS in apps/web/src/main.ts or create apps/web/src/styles.css.');
  }
}

export async function buildProject({ watch = false } = {}) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const external = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
  const available = [];
  const missing = [];
  for (const target of targets) {
    if (await exists(join(root, target.entry))) available.push(target);
    else missing.push(target.entry);
  }
  for (const entry of missing) console.error(`[build] Missing entry: ${entry}`);
  if (watch && missing.length) throw new Error('Development requires all three app entries. Implement the missing entries first.');

  // Clear old bundles so a partial build cannot leave stale runnable targets.
  await rm(join(root, 'dist'), { recursive: true, force: true });
  const contexts = [];
  const errors = [];
  for (const target of available) {
    const web = target.name === 'web';
    const options = {
      absWorkingDir: root,
      entryPoints: [target.entry],
      outfile: target.output,
      bundle: true,
      format: 'esm',
      platform: web ? 'browser' : 'node',
      target: web ? ['es2022'] : ['node22'],
      tsconfig,
      sourcemap: 'inline',
      logLevel: 'info',
      ...(web ? {
        plugins: [{
          name: 'web-assets',
          setup(builder) {
            builder.onEnd(async (result) => {
              if (result.errors.length === 0) await copyWebAssets();
            });
          },
        }],
      } : { external }),
    };
    try {
      if (watch) {
        const watcher = await context(options);
        contexts.push(watcher);
        await watcher.rebuild();
        await watcher.watch();
      } else {
        await build(options);
      }
      console.log(`[build] ${target.entry} -> ${target.output}`);
    } catch (error) {
      errors.push(`${target.name}: ${error.message}`);
    }
  }
  if (missing.length || errors.length) {
    await Promise.all(contexts.map((watcher) => watcher.dispose()));
    throw new Error([
      ...(missing.length ? [`Incomplete build: ${missing.length} app entry/entries missing.`] : []),
      ...errors,
    ].join('\n'));
  }
  return contexts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildProject();
  } catch (error) {
    console.error(`[build] ${error.message}`);
    process.exitCode = 1;
  }
}
