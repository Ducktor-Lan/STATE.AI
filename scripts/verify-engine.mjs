import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expectedEngine, generated, hash } from './prepare-engine.mjs';
async function list(directory,prefix='') {
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isSymbolicLink())throw new Error(`Generated symlink: ${path}`);
    if(entry.isDirectory())files.push(...await list(join(directory,entry.name),path));else if(entry.isFile())files.push(path);else throw new Error(`Invalid generated entry: ${path}`);
  }
  return files;
}
try {
  const {sources,manifest}=await expectedEngine();
  const recorded=JSON.parse(await readFile(join(generated,'ENGINE.json'),'utf8'));
  if(JSON.stringify(recorded)!==JSON.stringify(manifest))throw new Error('Generated engine manifest mismatch; run engine:prepare');
  const paths=await list(join(generated,'src'));
  if(paths.length!==sources.size||paths.some(path=>!sources.has(path)))throw new Error('Generated source file list mismatch');
  for(const [path,expected] of sources)if(hash(await readFile(join(generated,'src',path)))!==hash(expected))throw new Error(`Generated engine hash mismatch: ${path}`);
  console.log(`[engine] Verified ${sources.size} generated files, upstream bytes, patch occurrence counts and SHA-256 outputs.`);
}catch(error){console.error(`[engine] ${error.message}`);process.exitCode=1;}
