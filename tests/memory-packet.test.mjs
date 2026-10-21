import test from 'node:test';
import assert from 'node:assert/strict';
import {retrievalPacket} from '../scripts/memory-packet.mjs';

test('bounded packets preserve pointers and unresolved contradictions without rewriting evidence',()=>{
 const result={hits:[{id:'f1',content:'가'.repeat(400),sources:2}],needs_review:[{id:'f2',content:'x'.repeat(400),conflicts_with:['f1']}]};
 const original=structuredClone(result);
 const p=retrievalPacket(result,{byte_budget:512});
 assert.ok(Buffer.byteLength(JSON.stringify(p))<=512);
 assert.equal(p.truncated,true);assert.equal(p.authority,'advisory');
 assert.equal(p.omitted.length,2);
 assert.deepEqual(p.omitted[1].conflicts_with,['f1']);
 assert.deepEqual(p.omitted[0].source_pointer,{fragment:'f1'});
 assert.deepEqual(result,original);
 const full=retrievalPacket(result);
 assert.equal(full.truncated,false);assert.equal(full.hits[0].content,result.hits[0].content);
});

test('budgets cannot silently discard contradiction pointers',()=>{
 const result={hits:[],needs_review:Array.from({length:20},(_,i)=>({id:'f'+i,conflicts_with:['f0']}))};
 assert.throws(()=>retrievalPacket(result,{byte_budget:512}),/MEMORY_PACKET_BUDGET/);
 for(const byte_budget of [0,NaN,Infinity,513.5,65537])assert.throws(()=>retrievalPacket(result,{byte_budget}),/byte_budget/);
});
