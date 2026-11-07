import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run,nonConverging} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {REVIEW_CONVERGENCE_LIMIT} from '../scripts/executor-config.mjs';

// L01 run 10: one delegated reviewer rejected AC2 in 16 rounds across six workers, each time with a new edge case.
const rejection=(round,owner,blocking,extra={})=>({verdict:'redo',owner,round,blocking_criteria:blocking,consult_id:'c'+round,...extra});

test('the limit is two earlier delegated rejections of the same criterion',()=>{
 assert.equal(REVIEW_CONVERGENCE_LIMIT,2);
});

test('a criterion rejected by delegated reviews in two earlier rounds is not converging, even across workers',()=>{
 const s={iteration:3,reviews:[rejection(1,'terra',['AC2: secrets leak']),rejection(2,'grok',['AC2: escaped quotes leak'])]};
 const r=nonConverging(s,'redo',['AC2: multiline values leak']);
 assert.deepEqual(r.criteria,['AC2']);
 assert.equal(r.rounds,2);
 assert.deepEqual(r.history.map(h=>[h.round,h.owner]),[[1,'terra'],[2,'grok']]);
});

test('one earlier rejection, a new criterion, a pass or the lead\'s own verdicts do not trigger it',()=>{
 const once={iteration:2,reviews:[rejection(1,'terra',['AC2: x'])]};
 assert.equal(nonConverging(once,'redo',['AC2: y']),null);
 const twice={iteration:3,reviews:[rejection(1,'terra',['AC2: x']),rejection(2,'grok',['AC2: y'])]};
 assert.equal(nonConverging(twice,'redo',['AC2: z','AC3: new gap']),null,'a criterion that was not rejected before still goes back to the worker');
 assert.equal(nonConverging(twice,'pass',[]),null);
 const lead={iteration:3,reviews:[rejection(1,'terra',['AC2: x'],{consult_id:undefined}),rejection(2,'grok',['AC2: y'],{consult_id:undefined})]};
 assert.equal(nonConverging(lead,'redo',['AC2: z']),null,'only delegated rejections count');
 const sameRound={iteration:2,reviews:[rejection(1,'terra',['AC2: x']),rejection(2,'grok',['AC2: y'])]};
 assert.equal(nonConverging(sameRound,'redo',['AC2: z']),null,'the current round does not count against itself');
});

test('alternative counts as a rejection; history keeps the last six rounds and short reasons',()=>{
 const reviews=Array.from({length:8},(_,i)=>rejection(i+1,'w'+i,['AC1: '+'x'.repeat(300)]));
 const r=nonConverging({iteration:9,reviews},'alternative',['AC1: again']);
 assert.equal(r.rounds,8);
 assert.equal(r.history.length,6);
 assert.equal(r.history[0].round,3);
 assert.equal(r.history[0].blocking_criteria[0].length,200);
});

// End to end: the third delegated rejection of AC1 waits for the lead instead of going back automatically.
test('the third delegated rejection of the same criterion waits for the lead even with auto_apply',async t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate'},external:{default:'grok',available:['grok','sonnet','haiku']}}));
 run(f.root,'init',{...f.brief,executor:'grok'});
 const delegate=async()=>{const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);return run(f.root,'consult-finish',{quiescent:true}).review;};
 const next=()=>{const phase=f.state().phase;if(phase==='REDO')return f.begin();const pick=['sonnet','haiku','grok'].find(x=>x!==f.state().owner);return f.begin({executor:pick});};
 f.begin();f.finish();
 f.mode('review-redo');
 const outcomes=[];
 for(let i=0;i<3;i++){
  if(i)next(),f.finish();
  const out=await delegate();
  outcomes.push(out);
  if(out.status==='pending')break;
 }
 assert.deepEqual(outcomes.slice(0,2).map(o=>o.status),['applied','applied']);
 const last=outcomes[2];
 assert.equal(last.status,'pending');
 assert.equal(last.reason,'not_converging');
 assert.deepEqual(last.criteria,['AC1']);
 assert.match(last.next_action,/adopt/);
 const s=f.state();
 assert.equal(s.phase,'REVIEW');
 assert.deepEqual(s.pending_review.not_converging.criteria,['AC1']);
 assert.equal(s.reviews.length,2,'the third rejection is not applied yet');
 f.mode('ok');
 assert.equal(run(f.root,'review',{adopt:true}).phase!=='REVIEW',true,'the lead can still send it back');
});
