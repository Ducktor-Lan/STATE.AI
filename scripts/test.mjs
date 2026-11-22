import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ignored = new Set(['node_modules', 'dist', '.generated', '.git', 'artifacts', 'runs', 'output', 'outputs', 'coverage', '.tmp', 'tmp']);

async function discover(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !ignored.has(entry.name)) files.push(...await discover(path));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

let temporary;
try {
  const tests = (await Promise.all(['tests', 'packages'].map((path) => discover(join(root, path))))).flat().sort();
  if (tests.length === 0) throw new Error('No *.test.ts files found under tests/ or packages/. Add real tests before running npm test.');
  temporary = await mkdtemp(join(tmpdir(), 'state-ai-tests-'));
  // External dependencies must remain resolvable from OS temporary bundles.
  await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const external = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
  const bundles = [];
  for (const test of tests) {
    const output = join(temporary, relative(root, test).replace(/\.ts$/, '.mjs'));
    await build({
      absWorkingDir: root,
      entryPoints: [test],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      tsconfig: join(root, 'tsconfig.json'),
      external,
      sourcemap: 'inline',
      logLevel: 'warning',
    });
    bundles.push(output);
  }
  console.log(`[test] Running ${bundles.length} bundled test file(s) from ${temporary}`);
  const result = spawnSync(process.execPath, ['--test', ...bundles], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`[test] ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
