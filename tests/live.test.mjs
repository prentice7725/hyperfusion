import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {run} from '../scripts/fusion-state.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {controlPath} from '../scripts/control-dir.mjs';

test('live CLI smoke writes one bounded file and closes the task', {skip:process.env.HF_LIVE!=='1',timeout:180000},async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hf-live-')),root=path.join(temp,'repo');fs.mkdirSync(root);
 const old=process.env.HF_STATE_DIR;process.env.HF_STATE_DIR=path.join(temp,'state');
 t.after(()=>{if(old===undefined)delete process.env.HF_STATE_DIR;else process.env.HF_STATE_DIR=old;fs.rmSync(temp,{recursive:true,force:true});});
 const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
 git('init');git('config','user.name','Live smoke');git('config','user.email','smoke@example.invalid');
 fs.writeFileSync(path.join(root,'answer.txt'),'pending\n');git('add','.');git('commit','-m','smoke baseline');
 const executor=process.env.HF_LIVE_EXECUTOR??'sonnet';
 fs.writeFileSync(path.join(root,'hyperfusion.config.json'),JSON.stringify({external:{default:executor,available:[executor]},limits:{max_wall_ms:120000}}));
 const brief={task_id:'live-smoke',objective:'Replace answer.txt with exactly "ok" followed by a newline.',scope:{paths:['answer.txt']},constraints:[],success_criteria:['AC1: answer.txt is exactly ok followed by a newline'],allowed_actions:['read','edit']};
 run(root,'init',brief);run(root,'begin',brief);await execute(root);
 const state=()=>read(controlPath(root,'state.json'));
 const done=run(root,'finish',{token:state().writer.token,quiescent:true});assert.equal(done.phase,'REVIEW',JSON.stringify(done.last_errors));
 assert.equal(fs.readFileSync(path.join(root,'answer.txt'),'utf8'),'ok\n');
 run(root,'review',{verdict:'pass',rationale:'Inspected snapshot and exact output',blocking_criteria:[],commands_run:['read answer.txt'],independent_diff_review:true});
 assert.equal(run(root,'verify',{acceptance_satisfied:true,tests:[{command:'assert exact answer.txt contents',status:'pass'}]}).phase,'CLOSE');
});
