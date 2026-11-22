import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, 'vendor', 'state-conquest');

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${path}`);
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), path));
    else files.push(path);
  }
  return files;
}

try {
  const manifest = JSON.parse(await readFile(join(vendor, 'UPSTREAM.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Invalid or empty vendor manifest.');
  }
  const expected = new Set();
  let bytes = 0;
  for (const file of manifest.files) {
    const path = resolve(vendor, file.path);
    if (!path.startsWith(`${vendor}${sep}`) || expected.has(file.path)) throw new Error(`Invalid/duplicate manifest path: ${file.path}`);
    expected.add(file.path);
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Unexpected symlink: ${file.path}`);
    const data = await readFile(path);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (sha256 !== file.sha256 || data.length !== file.bytes) throw new Error(`Vendor bytes differ: ${file.path}`);
    bytes += data.length;
  }
  const actual = (await listFiles(vendor)).filter((path) => path !== 'UPSTREAM.json');
  for (const path of actual) if (!expected.has(path)) throw new Error(`Unrecorded vendor file: ${path}`);
  if (actual.length !== expected.size) throw new Error('Vendor file count differs from manifest.');
  console.log(`[vendor] Verified ${expected.size} files (${bytes} bytes), upstream ${manifest.commit}, src tree ${manifest.sourceTree}.`);
} catch (error) {
  console.error(`[vendor] ${error.message}`);
  process.exitCode = 1;
}
