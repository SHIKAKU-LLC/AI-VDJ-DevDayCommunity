// Immutable Git source only. Produces reviewable Edge files, never deploys.
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const knownBuiltins=new Set(['node:crypto','node:buffer']);
const parseImports=`import {SourceTextModule} from 'node:vm';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const module=new SourceTextModule(Buffer.concat(chunks).toString('utf8'));
process.stdout.write(JSON.stringify(module.dependencySpecifiers));`;
export async function buildEdgeRuntimeCandidate({repo,commit,output}){
 if(!/^[a-f0-9]{40}$/.test(commit)||!path.isAbsolute(output))throw Error('IMMUTABLE_EDGE_CANDIDATE_REQUIRED');
 try{await stat(output);throw Error('NEW_EDGE_OUTPUT_REQUIRED');}catch(e){if(e.code!=='ENOENT')throw e;}
 const pending=['cloud/room/entry.mjs'],files=new Map();
 while(pending.length){const file=pending.pop();if(files.has(file))continue;
  if(!/^(cloud\/|snapshot\/app\/runtime\/)[A-Za-z0-9_./-]+\.mjs$/.test(file)||file.includes('..'))throw Error('EDGE_SOURCE_REFUSED');
  const bytes=execFileSync('git',['show',commit+':'+file],{cwd:repo,maxBuffer:1024*1024}),source=bytes.toString('utf8');files.set(file,bytes);
  if(bytes.length>1024*1024)throw Error('EDGE_SOURCE_REFUSED');
  if(/\bDeno\s*\.\s*Command\b|find-generic-password|SUPABASE_DB_PASSWORD/.test(source))throw Error('NATIVE_DEPENDENCY_IN_EDGE');
  if(/\bimport\s*\(/.test(source))throw Error('DYNAMIC_EDGE_IMPORT_REVIEW_REQUIRED');
  // Parse declarations without evaluating module code. SQL strings/comments
  // containing "from 'object'" are never interpreted as imports.
  const specifiers=JSON.parse(execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',parseImports],
   {input:bytes,maxBuffer:1024*1024,stdio:['pipe','pipe','ignore']}).toString('utf8'));
  for(const specifier of specifiers){
   if(specifier.startsWith('.'))pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier)));
   else if(!knownBuiltins.has(specifier))throw Error(specifier.startsWith('node:')?'NATIVE_DEPENDENCY_IN_EDGE':'EDGE_IMPORT_REFUSED');
  }
 }
 await mkdir(output,{recursive:false});const manifest={commit,entrypoint:'cloud/room/entry.mjs',
  runtimeDefaultOff:/enabled:\s*false/.test(files.get('cloud/room/runtime-broker-config.mjs')?.toString('utf8')??''),files:{}};
 for(const [file,bytes] of files){const target=path.join(output,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);
  manifest.files[file]=createHash('sha256').update(bytes).digest('hex');}
 await writeFile(output+'.manifest.json',JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]?.endsWith('/build_edge_runtime_candidate.mjs')){
 const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
 await buildEdgeRuntimeCandidate({repo:path.resolve(new URL('..',import.meta.url).pathname),commit:arg('commit'),output:arg('output')});
}
