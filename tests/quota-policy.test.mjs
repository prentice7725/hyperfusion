import test from 'node:test';
import assert from 'node:assert/strict';
import {validateQuota,quotaStatus,exhaustedExecutors} from '../scripts/quota-policy.mjs';
const base={provider:'xai',source:'user_manual',collected_at:'2026-10-10T00:00:00Z',ttl_ms:1000,remaining:0,unit:'requests'};
test('manual quota, expiry, reset and future observations never fabricate balances',()=>{
 const q=validateQuota(base),time=Date.parse(base.collected_at);
 assert.equal(quotaStatus(q,time).exhausted,true);
 assert.equal(quotaStatus(q,time+1001).remaining,null);
 assert.equal(quotaStatus(q,time+1000).state,'stale');
 assert.equal(quotaStatus({...q,reset_at:base.collected_at},time).state,'stale');
 assert.equal(quotaStatus(q,time-120000).state,'unknown');
 assert.equal(quotaStatus(null,time).remaining,null);
 assert.equal(quotaStatus({...q,source:'unknown'},time).remaining,null);
 assert.deepEqual(exhaustedExecutors({xai:quotaStatus(q,time)},['grok','luna']),['grok']);
 assert.throws(()=>validateQuota({...base,source:'supported_tool'}),/no verified quota tool/);
 assert.throws(()=>validateQuota({...base,ttl_ms:-1}),/ttl_ms/);
 assert.throws(()=>validateQuota({...base,unit:null}),/unit/);
});

// ── Codex 로컬 세션 기록에서 잔량 읽기 ──
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './support.mjs';
import {collectCodexQuota,quotaReport} from '../scripts/quota-policy.mjs';
import {codexQuotaInput} from '../scripts/codex-quota.mjs';

const tokenCount=(timestamp,rate_limits)=>JSON.stringify({timestamp,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:1}},rate_limits}});
const codexHome=(t,files)=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'hf-codex-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 for(const [name,lines,mtime] of files){
  const file=path.join(home,'sessions',...name.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,lines.join('\n')+'\n');fs.utimesSync(file,mtime/1000,mtime/1000);
 }
 return home;
};
const T=Date.parse('2026-10-12T00:00:00Z');

test('Codex quota comes from the newest rate_limits record: the tightest window, stamped with that record\'s own time',t=>{
 const home=codexHome(t,[
  ['2026/10/11/rollout-old.jsonl',[tokenCount('2026-10-11T01:00:00Z',{primary:{used_percent:5,window_minutes:300,resets_at:1791700000},secondary:{used_percent:5,window_minutes:10080,resets_at:1792000000}})],T-86400000],
  ['2026/10/12/rollout-new.jsonl',[
   tokenCount('2026-10-12T00:00:00Z',{primary:{used_percent:20,window_minutes:300,resets_at:1791800000},secondary:{used_percent:80.5,window_minutes:10080,resets_at:1792100000}}),
   JSON.stringify({timestamp:'2026-10-12T00:00:05Z',type:'event_msg',payload:{type:'token_count',info:null,rate_limits:null}}), // exec 실행: null은 건너뛴다
   JSON.stringify({type:'response_item',payload:{type:'message',content:'secret prose that must never be read into a record'}})],T]]);
 const found=codexQuotaInput(home);
 assert.equal(found.ok,true);
 const q=found.input;
 assert.equal(q.provider,'openai');assert.equal(q.source,'supported_tool');
 assert.equal(q.collected_at,'2026-10-12T00:00:00.000Z','the record time, not now');
 assert.equal(q.window,'secondary 10080min');assert.equal(q.remaining,19.5);assert.equal(q.limit,100);assert.equal(q.unit,'percent');
 assert.equal(q.reset_at,new Date(1792100000*1000).toISOString());
 assert.ok(!JSON.stringify(q).includes('secret prose'));
});

test('collect-codex records a fresh status, goes stale with age, and exhausted means 0 left',t=>{
 const f=fixture(t,{initialize:false});
 const home=codexHome(t,[['2026/10/12/r.jsonl',[tokenCount(new Date().toISOString(),{primary:{used_percent:100,window_minutes:300,resets_at:Math.floor(Date.now()/1000)+3600}})],Date.now()]]);
 const out=collectCodexQuota(f.root,home);
 assert.equal(out.recorded,true);assert.equal(out.status.state,'fresh');assert.equal(out.status.exhausted,true);
 assert.equal(quotaReport(f.root).openai.exhausted,true);
 assert.equal(quotaReport(f.root,Date.now()+31*60*1000).openai.state,'stale','older than the TTL is not trusted');
});

test('with nothing to read, collect-codex records nothing and says why',t=>{
 const f=fixture(t,{initialize:false});
 const empty=codexHome(t,[]);
 const out=collectCodexQuota(f.root,empty);
 assert.equal(out.recorded,false);assert.match(out.reason,/no Codex session record with rate_limits/);
 const nulls=codexHome(t,[['2026/10/12/r.jsonl',[tokenCount('2026-10-12T00:00:00Z',null),'not json {rate_limits'],T]]);
 assert.equal(collectCodexQuota(f.root,nulls).recorded,false);
 assert.equal(quotaReport(f.root).openai.state,'unknown');
});
