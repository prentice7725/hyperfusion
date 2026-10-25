import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {lineEdits,unifiedHunks} from '../scripts/round-delta.mjs';

const apply=(a,ops)=>ops.filter(o=>o[0]!=='-').map(o=>o[1]);
const original=ops=>ops.filter(o=>o[0]!=='+').map(o=>o[1]);

test('line edits rebuild both sides and stop at the edit limit',()=>{
 const cases=[[[],[]],[[],['a']],[['a'],[]],[['a','b','c'],['a','x','c']],[['a','b','c','d'],['d','a','b']],['abcabba'.split(''),'cbabac'.split('')]];
 for(const [a,b] of cases){const ops=lineEdits(a,b);assert.deepEqual(original(ops),a);assert.deepEqual(apply(a,ops),b);}
 assert.equal(lineEdits('abcabba'.split(''),'cbabac'.split('')).filter(o=>o[0]!==' ').length,5,'Myers finds the shortest edit script');
 assert.equal(lineEdits(['a','b','c'],['x','y','z'],2),null);
});

test('unified hunks carry line numbers and three lines of context',()=>{
 const a=Array.from({length:30},(_,i)=>'line '+(i+1)),b=[...a];b[4]='line 5 changed';b[24]='line 25 changed';
 const text=unifiedHunks(lineEdits(a,b));
 assert.equal(text.split('\n').filter(l=>l.startsWith('@@')).length,2,'distant edits become separate hunks');
 assert.match(text,/^@@ -2,7 \+2,7 @@\n line 2\n line 3\n line 4\n-line 5\n\+line 5 changed\n line 6/);
 assert.equal(unifiedHunks(lineEdits(a,a)),'');
 assert.match(unifiedHunks(lineEdits([],['new'])),/^@@ -0,0 \+1,1 @@\n\+new$/);
});

test('round-diff shows only what the redo round changed on top of the previous round',t=>{
 const f=fixture(t);
 const file=path.join(f.root,'a.txt'),body=Array.from({length:30},(_,i)=>'line '+(i+1));
 assert.equal(run(f.root,'round-diff').reason,'FIRST_ROUND');
 f.begin();
 const r1=[...body];r1[4]='round one edit';fs.writeFileSync(file,r1.join('\n')+'\n');
 f.finish(f.result(['a.txt']));f.review('redo');
 assert.equal(run(f.root,'round-diff').reason,'FIRST_ROUND','round 1 has no earlier round');
 f.begin();
 const r2=[...r1];r2[24]='round two edit';fs.writeFileSync(file,r2.join('\n')+'\n');
 fs.writeFileSync(path.join(f.root,'a.bin'),Buffer.from([0,1,2]));
 const delta=run(f.root,'round-diff');
 assert.equal(delta.available,true);assert.equal(delta.authoritative,false);assert.equal(delta.round,2);
 const a=delta.files.find(x=>x.path==='a.txt');
 assert.equal(a.status,'modified');assert.match(a.diff,/-line 25\n\+round two edit/);
 assert.doesNotMatch(a.diff,/round one edit/,'the previous round edit is outside the context window and not repeated');
 assert.equal(delta.files.find(x=>x.path==='a.bin').status,'added');
 assert.equal(run(f.root,'round-diff',{char_budget:10}).omitted.length,2,'over budget entries keep their path');
 fs.rmSync(path.join(f.root,'a.bin'));
 f.finish(f.result(['a.txt']));
 const step=run(f.root,'next');
 assert.match(JSON.stringify(step),/round-diff/,'the review step points the lead at the round delta');
});

test('round-diff refuses a base that does not match the recorded round snapshot',t=>{
 const f=fixture(t);
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'one\n');f.finish(f.result(['a.txt']));f.review('redo');
 f.begin();
 const dir=path.join(f.control,'tasks',f.brief.task_id),name=path.join(dir,'round-base-2.json');
 const saved=JSON.parse(fs.readFileSync(name,'utf8'));
 assert.equal(saved.files['a.txt'].text,'one\n','begin recorded the content the round started from');
 fs.chmodSync(name,0o600);fs.writeFileSync(name,JSON.stringify({...saved,digest:'0'.repeat(64)}));
 assert.equal(run(f.root,'round-diff').reason,'ROUND_BASE_MISMATCH');
 fs.rmSync(name);
 assert.equal(run(f.root,'round-diff').reason,'ROUND_BASE_NOT_RECORDED');
});
