// Static input checks only. Never initialize a task or probe/launch an executor.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {brief as validateBrief} from '../scripts/contracts.mjs';
import {config} from '../scripts/executor-config.mjs';
import {takeAssignment} from '../scripts/review-plan.mjs';
import {takeDelegation,takeRedoDelegation} from '../scripts/delegation.mjs';
import {printError} from '../scripts/cli.mjs';

export function preflightBrief(input,configuration) {
 const candidate=structuredClone(input),settings=structuredClone(configuration),checks=[];
 const report={revision:1,authoritative:false,static_only:true,valid:false,checks,
  unchecked:['runtime executor availability and routing','project/workflow and existing task state','baseline test outcome and process supervision','protected-file matches and current tree','approval eligibility']};
 let assignment;
 for(const [name,check] of [
  ['assignment',()=>{assignment=takeAssignment(settings,candidate);}],
  ['delegation',()=>takeDelegation(settings,assignment,candidate)],
  ['redo_delegation',()=>takeRedoDelegation(settings,assignment,candidate)],
  ['brief',()=>validateBrief(candidate)]
 ]){
  try{check();checks.push({name,status:'pass'});}
  catch(e){checks.push({name,status:'fail',message:e.message});return report;}
 }
 report.valid=true;
 return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const [root,file,...rest]=process.argv.slice(2);
  if(!root||!file||rest.length)throw Error('Usage: node tools/preflight-brief.mjs REPO BRIEF.json');
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>1024*1024)throw Error('Brief must be a regular JSON file of at most 1 MiB');
  const report=preflightBrief(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),config(path.resolve(root)));
  console.log(JSON.stringify(report,null,2));
  if(!report.valid)process.exitCode=1;
 }catch(e){printError(e);}
}
