import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import {execute} from '../scripts/executor-bridge.mjs';

// 테스트 전용 대역 CLI. 실제 Grok/Antigravity 모델을 호출하지 않는다.
const FAKE_COMMON=`#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2);
const mode=fs.existsSync('.fusion/fake-mode')?fs.readFileSync('.fusion/fake-mode','utf8'):'ok';
const finish=(request,id)=>{
 const result={...request.result_template,summary:'Fake transport result; no live model'};
 if(mode==='edit'){fs.writeFileSync('a.txt','fixed');result.files_changed=['a.txt'];}
 if(mode==='lazy'){result.status='blocked';result.unresolved=['did not bother'];}
 return result;
};
`;
const FAKE_GROK=FAKE_COMMON+`
if(args.includes('--version')){console.log('FAKE grok for protocol tests');process.exit(0);}
if(args.includes('--help')){console.log('--prompt-file --output-format --session-id --resume --cwd --max-turns --allow --deny');process.exit(0);}
fs.writeFileSync('.fusion/fake-grok-args.json',JSON.stringify(args));
const request=JSON.parse(fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8'));
if(mode==='hang'){setInterval(()=>{},1000);}else{
 const resume=args.includes('--resume'),id=args[args.indexOf(resume?'--resume':'--session-id')+1];
 if(resume&&(!fs.existsSync('.fusion/fake-grok-session')||fs.readFileSync('.fusion/fake-grok-session','utf8')!==id)){console.log(JSON.stringify({type:'error',message:'no session'}));process.exit(1);}
 fs.writeFileSync('.fusion/fake-grok-session',id);
 if(mode==='bad-json'){console.log('invalid');process.exit(0);}
 if(mode==='oversize'){console.log('x'.repeat(10000));process.exit(0);}
 if(mode==='error'){console.log(JSON.stringify({type:'error',message:'boom'}));process.exit(0);}
 const result=finish(request,id);
 const text=mode==='prose'?'I think it is done.':mode==='fenced'?'Done.\\n\`\`\`json\\n'+JSON.stringify(result)+'\\n\`\`\`':JSON.stringify(result);
 console.log(JSON.stringify({text,stopReason:mode==='max-turns'?'max_turns':'end_turn',sessionId:mode==='bad-session'?'wrong':id,num_turns:3,usage:{input_tokens:10,output_tokens:5,total_tokens:15},total_cost_usd:0.002}));
 process.exit(mode==='nonzero'?2:0);
}
`;
const FAKE_AGY=FAKE_COMMON+`
if(args.includes('--version')){console.log('FAKE agy for protocol tests');process.exit(0);}
if(args.includes('--help')){console.log('-p, --print --output-format --json-schema --conversation --mode --add-dir --sandbox');process.exit(0);}
fs.writeFileSync('.fusion/fake-agy-args.json',JSON.stringify(args));
const request=JSON.parse(args[args.indexOf('-p')+1]);
const prior=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:null;
if(prior&&(!fs.existsSync('.fusion/fake-agy-session')||fs.readFileSync('.fusion/fake-agy-session','utf8')!==prior)){console.log(JSON.stringify({error:'unknown conversation'}));process.exit(1);}
const id=prior??'conv-'+Date.now();
fs.writeFileSync('.fusion/fake-agy-session',id);
const result=finish(request,id);
console.log(JSON.stringify({conversation_id:id,status:mode==='agy-fail'?'failed':'success',response:'done',structured_output:result,num_turns:2,usage:{total_tokens:20}}));
`;

export function fixture(t,{initialize=true,executor}={}) {
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hf-v03-')),root=path.join(temp,'repo');fs.mkdirSync(root);
 const old={grok:process.env.HF_GROK_BIN,agy:process.env.HF_AGY_BIN};
 t.after(()=>{
  for(const [k,v] of [['HF_GROK_BIN',old.grok],['HF_AGY_BIN',old.agy]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  fs.rmSync(temp,{recursive:true,force:true});
 });
 const grok=path.join(temp,'fake grok'),agy=path.join(temp,'fake agy');
 fs.writeFileSync(grok,FAKE_GROK,{mode:0o755});fs.writeFileSync(agy,FAKE_AGY,{mode:0o755});
 process.env.HF_GROK_BIN=grok;process.env.HF_AGY_BIN=agy;
 const git=(...a)=>execFileSync('git',['-C',root,...a],{stdio:'pipe'});
 git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');
 fs.writeFileSync(path.join(root,'a.txt'),'base');git('add','.');git('commit','-m','fixture');fs.appendFileSync(path.join(root,'.git/info/exclude'),'\n/.fusion/\n');
 const brief={task_id:'HF-test',objective:'Fix a bounded issue',scope:{paths:['a.txt'],allowed_expansion:'ask-lead'},constraints:[],success_criteria:['AC1'],allowed_actions:['read','edit','test'],forbidden_actions:['commit','push','deploy','release','scope-expansion'],evidence_required:['files_changed','commands_run','test_results','remaining_risks']};
 const state=()=>read(path.join(root,'.fusion/state.json'));
 const orders=['Fix AC1 for real this time'];
 // PLAN 이후의 재지시에는 명령서를 자동으로 붙인다.
 const begin=(extra={})=>run(root,'begin',{...brief,...(state().phase==='PLAN'||state().phase==='TAKEOVER_REQUIRED'?{}:{lead_feedback:orders}),...extra});
 const result=(files=[])=>({task_id:brief.task_id,round:state().iteration,status:'complete',summary:'Test result',files_read:[],files_changed:files,commands_run:[],tests:[],unresolved:[],risks:[],needs_lead_decision:false,recommended_next_action:'review'});
 const finish=(r=result())=>run(root,'finish',{token:state().writer.token,quiescent:true,result:r});
 const review=(verdict='pass',criteria=['AC1'])=>run(root,'review',{verdict,rationale:'Inspected source',blocking_criteria:verdict==='pass'?[]:criteria,commands_run:['git diff'],independent_diff_review:true});
 const mode=v=>fs.writeFileSync(path.join(root,'.fusion/fake-mode'),v);
 const bridge=async()=>{const out=await execute(root);finish(read(out.result_file));return out;};
 if(initialize)run(root,'init',{...brief,...(executor?{executor}:{})});
 return {root,temp,brief,state,begin,result,finish,review,mode,bridge,git};
}
