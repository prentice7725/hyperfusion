
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import {execute} from '../scripts/claude-bridge.mjs';
export function fixture(t,{initialize=true}={}) {
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hf-v02-')),root=path.join(temp,'repo');fs.mkdirSync(root);
 const old=process.env.HF_CLAUDE_BIN;
 t.after(()=>{if(old===undefined)delete process.env.HF_CLAUDE_BIN;else process.env.HF_CLAUDE_BIN=old;fs.rmSync(temp,{recursive:true,force:true});});
 const binary=path.join(temp,'fake claude');
 fs.writeFileSync(binary,`#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('FAKE CLI for protocol tests');process.exit(0);}
if(args.includes('--help')){console.log('--output-format --json-schema --resume --session-id --safe-mode --tools --allowedTools --disallowedTools --permission-mode --max-turns');process.exit(0);}
const request=JSON.parse(fs.readFileSync(0,'utf8'));
fs.writeFileSync('.fusion/fake-args.json',JSON.stringify(args));
const mode=fs.existsSync('.fusion/fake-mode')?fs.readFileSync('.fusion/fake-mode','utf8'):'ok';
if(mode==='hang'){setInterval(()=>{},1000);}else{
 const resume=args.includes('--resume'),id=args[args.indexOf(resume?'--resume':'--session-id')+1];
 if(resume&&(!fs.existsSync('.fusion/fake-session')||fs.readFileSync('.fusion/fake-session','utf8')!==id)){console.log('{}');process.exit(1);}
 fs.writeFileSync('.fusion/fake-session',id);
 if(mode==='bad-json'){console.log('invalid');process.exit(0);}
 if(mode==='oversize'){console.log('x'.repeat(10000));process.exit(0);}
 const result={...request.result_template,summary:'Fake transport result; no live model'};
 if(mode==='edit'){fs.writeFileSync('a.txt','fixed');result.files_changed=['a.txt'];}
 const envelope={type:'result',subtype:mode==='error'?'error_during_execution':'success',is_error:mode==='error',session_id:mode==='bad-session'?'wrong':id,structured_output:result,usage:{input_tokens:10,output_tokens:5},total_cost_usd:0.001};
 if(mode==='denied')envelope.permission_denials=[{tool_name:'Bash'}];
 console.log(JSON.stringify(envelope));process.exit(mode==='nonzero'?2:0);
}
`,{mode:0o755});
 process.env.HF_CLAUDE_BIN=binary;
 const git=(...a)=>execFileSync('git',['-C',root,...a],{stdio:'pipe'});
 git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');
 fs.writeFileSync(path.join(root,'a.txt'),'base');git('add','.');git('commit','-m','fixture');fs.appendFileSync(path.join(root,'.git/info/exclude'),'\n/.fusion/\n');
 const brief={task_id:'HF-test',objective:'Fix a bounded issue',scope:{paths:['a.txt'],allowed_expansion:'ask-lead'},constraints:[],success_criteria:['AC1'],allowed_actions:['read','edit','test'],forbidden_actions:['commit','push','deploy','release','scope-expansion'],evidence_required:['files_changed','commands_run','test_results','remaining_risks']};
 const state=()=>read(path.join(root,'.fusion/state.json'));
 const begin=(extra={})=>run(root,'begin',{...brief,...extra});
 const result=(files=[])=>({task_id:brief.task_id,round:state().iteration,status:'complete',summary:'Test result',files_read:[],files_changed:files,commands_run:[],tests:[],unresolved:[],risks:[],needs_lead_decision:false,recommended_next_action:'review'});
 const finish=(r=result())=>run(root,'finish',{token:state().writer.token,quiescent:true,result:r});
 const review=(verdict='pass')=>run(root,'review',{verdict,rationale:'Inspected source',blocking_criteria:verdict==='pass'?[]:['AC1'],commands_run:['git diff'],independent_diff_review:true});
 const mode=v=>fs.writeFileSync(path.join(root,'.fusion/fake-mode'),v);
 const bridge=async()=>{const out=await execute(root);finish(read(out.result_file));return out;};
 if(initialize)run(root,'init',brief);
 return {root,temp,binary,brief,state,begin,result,finish,review,mode,bridge,git};
}
