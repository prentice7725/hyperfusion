// Optional local overhead measurements. No models, acceptance commands or state writes.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {snapshot} from '../scripts/artifact.mjs';
import {ignoredManifest} from '../scripts/acceptance.mjs';
import {findingLedger} from '../scripts/finding-ledger.mjs';
import {printError} from '../scripts/cli.mjs';

const MAX_ENTRIES=10000,MAX_BYTES=32*1024*1024;
function ledgerInput(stateFile,dir) {
 const stateStat=fs.lstatSync(stateFile);
 if(!stateStat.isFile()||stateStat.isSymbolicLink()||stateStat.size>1024*1024)throw Error('State must be a regular JSON file of at most 1 MiB');
 if(fs.lstatSync(dir).isSymbolicLink())throw Error('Task directory must not be a symlink');
 const names=fs.readdirSync(dir);
 if(names.length>MAX_ENTRIES)throw Error('Profile task directory exceeds 10000 entries');
 let bytes=0;
 for(const name of names){
  const st=fs.lstatSync(path.join(dir,name));
  if(!st.isFile()||st.isSymbolicLink()||st.size>4*1024*1024)throw Error('Profile task artifacts must be regular files of at most 4 MiB');
  bytes+=st.size;
  if(bytes>MAX_BYTES)throw Error('Profile task artifacts exceed 32 MiB');
 }
 return JSON.parse(fs.readFileSync(stateFile,'utf8').replace(/^\uFEFF/,''));
}

export function profileController(root,{repetitions=3,stateFile=null,taskDir=null}={}) {
 if(!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>10)throw Error('Profile repetitions must be 1-10');
 if(Boolean(stateFile)!==Boolean(taskDir))throw Error('Supply both --state and --task-dir for ledger measurements');
 const state=stateFile?ledgerInput(stateFile,taskDir):null;
 const operations=[['snapshot',()=>snapshot(root),v=>({files:Object.keys(v.files).length})],
  ['ignoredManifest',()=>ignoredManifest(root),v=>({listed:v.count,watched:Object.keys(v.files).length,overflow:v.overflow})]];
 if(state)operations.push(['findingLedger',()=>findingLedger(state,taskDir),v=>({issues:v.issues.length,observations:v.observation_count,sources:v.source_count,warnings:v.warnings.length})]);
 const measurements={};
 for(const [name,run,counts] of operations){
  const samples=[];
  for(let i=0;i<repetitions;i++){
   const start=performance.now(),value=run(),elapsed_ms=performance.now()-start;
   samples.push({elapsed_ms,counts:counts(value)});
  }
  const times=samples.map(s=>s.elapsed_ms).sort((a,b)=>a-b),middle=Math.floor(times.length/2);
  measurements[name]={samples,min_ms:times[0],median_ms:times.length%2?times[middle]:(times[middle-1]+times[middle])/2,max_ms:times.at(-1)};
 }
 return {revision:1,authoritative:false,repetitions,node:process.version,platform:process.platform,measurements,
  exclusions:['model time and usage','acceptance/test execution','approval or runtime eligibility'],
  note:'Observed local wall time only; filesystem caches and concurrent changes affect samples. No evidence is cached for controller decisions.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const [root,...args]=process.argv.slice(2),options={};
  if(!root)throw Error('Usage: node tools/profile-controller.mjs REPO [--repetitions 1-10] [--state FILE --task-dir DIR]');
  const names={'--repetitions':'repetitions','--state':'stateFile','--task-dir':'taskDir'};
  for(let i=0;i<args.length;i+=2){
   const key=names[args[i]],value=args[i+1];
   if(!key||value===undefined||options[key]!==undefined)throw Error('Invalid or duplicate profile option');
   options[key]=key==='repetitions'?Number(value):path.resolve(value);
  }
  console.log(JSON.stringify(profileController(path.resolve(root),options),null,2));
 }catch(e){printError(e);}
}
