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
