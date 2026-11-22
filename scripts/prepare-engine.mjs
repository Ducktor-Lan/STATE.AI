import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const generated = join(root, '.generated', 'state-conquest');
export const hash = value => createHash('sha256').update(value).digest('hex');
async function list(directory, prefix='') {
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isSymbolicLink())throw new Error(`Unexpected symlink: ${path}`);
    if(entry.isDirectory())files.push(...await list(join(directory,entry.name),path));
    else if(entry.isFile())files.push(path);
    else throw new Error(`Unsupported filesystem entry: ${path}`);
  }
  return files.sort();
}
export async function expectedEngine() {
  const vendor=join(root,'vendor','state-conquest');
  const upstreamBytes=await readFile(join(vendor,'UPSTREAM.json'));
  const upstream=JSON.parse(upstreamBytes.toString('utf8'));
  const patchBytes=await readFile(join(root,'patches','state-conquest','arena.patch.json'));
  const patch=JSON.parse(patchBytes.toString('utf8'));
  if(upstream.schemaVersion!==1||patch.schemaVersion!==1||!upstream.commit?.startsWith(patch.upstreamCommitPrefix)||!Array.isArray(upstream.files)||!upstream.files.length)throw new Error('Invalid upstream/patch manifest or unexpected upstream commit');
  const expected=new Set(),sources=new Map();
  for(const file of upstream.files) {
    const path=resolve(vendor,file.path);
    if(!path.startsWith(vendor+sep)||expected.has(file.path))throw new Error(`Unsafe/duplicate upstream path: ${file.path}`);
    expected.add(file.path);
    if((await lstat(path)).isSymbolicLink())throw new Error(`Vendor symlink: ${file.path}`);
    const bytes=await readFile(path);
    if(bytes.length!==file.bytes||hash(bytes)!==file.sha256)throw new Error(`Vendor hash mismatch: ${file.path}`);
    if(file.path.startsWith('src/'))sources.set(file.path.slice(4),bytes);
  }
  const actual=(await list(vendor)).filter(p=>p!=='UPSTREAM.json');
  if(actual.length!==expected.size||actual.some(p=>!expected.has(p)))throw new Error('Vendor file list does not match UPSTREAM.json');
  if(!sources.has('core/engine.ts')||!sources.has('rendering/canvas-renderer.ts'))throw new Error('Missing upstream engine or renderer');
  const patchedPaths=new Set();
  for(const file of patch.files) {
    if(patchedPaths.has(file.path))throw new Error(`Duplicate patch: ${file.path}`);
    patchedPaths.add(file.path);
    const source=sources.get(file.path);
    if(!source||hash(source)!==file.expectedSourceSha256)throw new Error(`Patch source hash mismatch: ${file.path}`);
    let text=source.toString('utf8');
    for(const replacement of file.replacements) {
      if(!replacement.before||!Number.isSafeInteger(replacement.count)||replacement.count<1)throw new Error('Invalid explicit replacement');
      if(text.split(replacement.before).length-1!==replacement.count)throw new Error(`Patch occurrence mismatch: ${file.path}`);
      text=text.split(replacement.before).join(replacement.after);
    }
    const bytes=Buffer.from(text);
    if(hash(bytes)!==file.expectedOutputSha256)throw new Error(`Patch output hash mismatch: ${file.path}`);
    sources.set(file.path,bytes);
  }
  const manifest={schemaVersion:1,upstreamCommit:upstream.commit,upstreamManifestSha256:hash(upstreamBytes),patchSha256:hash(patchBytes),files:[...sources].sort(([a],[b])=>a.localeCompare(b)).map(([path,data])=>({path,bytes:data.length,sha256:hash(data),patched:patchedPaths.has(path)}))};
  return {sources,manifest};
}
export async function prepareEngine() {
  const {sources,manifest}=await expectedEngine();
  await mkdir(generated,{recursive:true});
  const staging=join(generated,`.prepare-${process.pid}`);
  await rm(staging,{recursive:true,force:true});
  await mkdir(staging,{recursive:true});
  try {
    for(const [path,data] of sources){const destination=join(staging,path);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,data);}
    await rm(join(generated,'src'),{recursive:true,force:true});
    await rename(staging,join(generated,'src'));
    await writeFile(join(generated,'ENGINE.json'),JSON.stringify(manifest,null,2)+'\n');
  }finally{await rm(staging,{recursive:true,force:true});}
  console.log(`[engine] Prepared ${sources.size} source files with ${manifest.files.filter(f=>f.patched).length} hash-pinned patches; upstream ${manifest.upstreamCommit}.`);
  return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)prepareEngine().catch(error=>{console.error(`[engine] ${error.message}`);process.exitCode=1;});
