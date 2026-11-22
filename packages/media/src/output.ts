import { promises as fs } from 'node:fs';
import path from 'node:path';

export function assertExportDirectory(directory: string, subject = 'Video exports'): string {
  const absolute = path.resolve(directory);
  if (!path.isAbsolute(directory) || !absolute.split(/[\\/]/).some(part => part === 'runs' || part === 'outputs')) throw new Error(`${subject} must use an absolute server-owned directory below ignored runs/ or outputs/.`);
  return absolute;
}

function isDescendant(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonicalPath(directory: string): Promise<string> {
  try { return await fs.realpath(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Resolve an existing ancestor before creating directories and reject broken links.
  const entry = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (entry) throw new Error('Output path contains an unresolved filesystem link');
  const parent = path.dirname(directory);
  if (parent === directory) throw new Error('Output path has no existing filesystem ancestor');
  return path.join(await canonicalPath(parent), path.basename(directory));
}

export async function resolveOutputDirectory(directory: string, root: string | undefined, subject?: string): Promise<string> {
  if (root === undefined) return assertExportDirectory(directory, subject);
  const outsideRoot = 'Output directory must be absolute and strictly below the absolute server-owned output root.';
  if (!path.isAbsolute(root) || !path.isAbsolute(directory) || !isDescendant(root, directory)) throw new Error(outsideRoot);
  const actualRoot = await canonicalPath(path.resolve(root));
  const actualDirectory = await canonicalPath(path.resolve(directory));
  if (!isDescendant(actualRoot, actualDirectory)) throw new Error(outsideRoot);
  return actualDirectory;
}
