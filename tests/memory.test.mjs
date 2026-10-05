import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {recall,commit,candidates,context} from '../scripts/memory.mjs';
import {AnchorMind} from '../scripts/memory-client.mjs';
import {checkCandidate,looksSecret} from '../scripts/memory-policy.mjs';

// AnchorMind 대역: Streamable HTTP MCP. 세션 헤더, SSE 응답, README에 적힌 인자 이름을 흉내 낸다.
async function fakeAnchorMind(t,{key='k1'}={}) {
 const store=[],calls=[];
 const tools=[
  {name:'context',inputSchema:{type:'object',properties:{workspace:{type:'string'}},required:['workspace']}},
  {name:'recall',inputSchema:{type:'object',properties:{workspace:{type:'string'},text:{type:'string'},type:{type:'string'},keywords:{type:'array'},limit:{type:'integer'}},required:['workspace','text']}},
  {name:'remember',inputSchema:{type:'object',properties:{workspace:{type:'string'},type:{type:'string'},content:{type:'string'},importance:{type:'number',minimum:0,maximum:1},keywords:{type:'array'},assertionStatus:{type:'string'},isAnchor:{type:'boolean'},ttl:{type:'string'}},required:['workspace','type','content']}}
 ];
 const server=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
  if(req.url==='/health'){res.end('ok');return;}
  if(req.headers.authorization!=='Bearer '+key){res.statusCode=401;res.end();return;}
  const m=JSON.parse(b);calls.push(m);
  if(m.method==='notifications/initialized'){res.statusCode=202;res.end();return;}
  if(m.method!=='initialize'&&req.headers['mcp-session-id']!=='s1'){res.statusCode=400;res.end();return;}
  let result;
  if(m.method==='initialize'){res.setHeader('Mcp-Session-Id','s1');result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake-anchormind'}};}
  else if(m.method==='tools/list')result={tools};
  else if(m.method==='tools/call'){
   const a=m.params.arguments;let out;
   if(m.params.name==='remember'){const f={id:'f'+(store.length+1),...a};store.push(f);out={id:f.id,stored:true};}
   else if(m.params.name==='recall')out={fragments:store.filter(f=>f.workspace===a.workspace&&a.text.split(' ').some(w=>f.content.includes(w))).slice(0,a.limit??8)};
   else out={anchors:store.filter(f=>f.workspace===a.workspace&&f.isAnchor)};
   result={content:[{type:'text',text:JSON.stringify(out)}]};
  }
  // tools/call은 SSE로, 나머지는 JSON으로 답해 두 형식을 모두 시험한다.
  if(m.method==='tools/call'){res.setHeader('Content-Type','text/event-stream');res.end(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:m.id,result})}\n\n`);}
  else {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));}
 });});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}/mcp`;
 const env={HF_MEMORY_URL:process.env.HF_MEMORY_URL,HF_MEMORY_KEY:process.env.HF_MEMORY_KEY};
 process.env.HF_MEMORY_URL=url;process.env.HF_MEMORY_KEY=key;
 t.after(()=>{for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 return {store,calls,url};
}
const withMemory=(t,workspace='hyperfusion-test')=>{const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({memory:{workspace}}));run(f.root,'init',{...f.brief,executor:'grok'});return f;};
const ledger=f=>candidates(f.root);

test('secrets, oversized text and worker decisions never become memory',()=>{
 for(const s of ['api_key = abc12345xyz','ghp_0123456789abcdefghijABCDEFGHIJ','sk-ant-api03-abcdefgh','Bearer abcdefghijklmnopqrstuvwxyz'])assert.ok(looksSecret(s),s);
 assert.ok(!looksSecret('ModuleNotFoundError in PixelOEPixelize+; do not retry the same setup'));
 assert.match(checkCandidate({type:'decision',content:'Use Krea2'},'worker').join(),/lead owns/);
 assert.match(checkCandidate({type:'episode',content:'x'.repeat(401)},'worker').join(),/400/);
 assert.match(checkCandidate({type:'fact',content:'Engine is Godot 4.5'},'lead').join(),/restricted/);
 assert.match(checkCandidate({type:'fact',content:'Engine is Godot 4.5',anchor_key:'MOOD'},'lead').join(),/anchor_key/);
 assert.deepEqual(checkCandidate({type:'fact',content:'Engine is Godot 4.5',anchor_key:'CURRENT_ENGINE',reason:'pointer for agents'},'lead'),[]);
});
test('memory stays off without a per-project workspace, and bad names are refused',async t=>{
 const f=fixture(t);f.begin();const r=f.result();r.memory_candidates=[{type:'error',content:'A failed because B'}];f.finish(r);
 assert.deepEqual(ledger(f).candidates,[]);
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({memory:{workspace:'my project!'}}));
 await assert.rejects(()=>recall(f.root,'x'),/workspace/);
});
test('worker lessons land in the ledger, not in AnchorMind',async t=>{
 const mem=await fakeAnchorMind(t);const f=withMemory(t);
 f.begin();const r=f.result();r.memory_candidates=[{type:'error',content:'Node 17 param A produced malformed output; B passed the gate',keywords:['comfyui']},{type:'decision',content:'Switch engines'}];f.finish(r);
 const c=ledger(f).candidates;
 assert.equal(c[0].status,'pending');assert.equal(c[0].source.executor,'grok');
 assert.equal(c[1].status,'invalid');assert.match(c[1].problems[0],/lead owns/);
 assert.equal(mem.store.length,0);
});
test('closing a task harvests failure→cause→fix→verification, committed only on lead approval',async t=>{
 const mem=await fakeAnchorMind(t);const f=withMemory(t);
 f.begin();f.finish();f.review('redo',['AC1']);
 f.begin();f.finish();f.review('pass');
 run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'npm test',status:'pass'}]});
 const c=ledger(f).candidates;
 assert.deepEqual(c.map(x=>x.type),['error','procedure','episode']);
 assert.match(c[0].content,/grok round 1 failed AC1.*Resolved by grok round 2/);assert.match(c[1].content,/npm test/);
 const out=await commit(f.root,{accept:['m1','m2'],reject:['m3']});
 assert.deepEqual(out.results.map(r=>r.status),['committed','committed','rejected']);
 assert.equal(mem.store.length,2);
 const saved=mem.store[0];
 assert.equal(saved.workspace,'hyperfusion-test');assert.equal(saved.assertionStatus,'verified');assert.equal(saved.importance,0.9);
 assert.ok(saved.keywords.includes('hf:HF-test')&&saved.keywords.includes('src:protocol'));
 assert.equal(saved.isAnchor,undefined);
});
test('worker and lead-added memories are stored as inferred, anchors only on the allow-list',async t=>{
 const mem=await fakeAnchorMind(t);const f=withMemory(t);
 f.begin();const r=f.result();r.memory_candidates=[{type:'procedure',content:'Run gate script before human review'}];f.finish(r);f.review('pass');
 run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'check',status:'pass'}]});
 const out=await commit(f.root,{accept:['m1'],add:[{type:'decision',content:'Pixel pipeline excludes Qwen2.1; Anima + Krea2 are the default generators'},{type:'fact',content:'Design SOT lives in Google Drive folder GDD/',anchor_key:'SOT_LOCATION',reason:'pointer, not the design itself'}]});
 assert.ok(out.results.every(r=>r.status==='committed'));
 const byContent=x=>mem.store.find(f=>f.content.startsWith(x));
 assert.equal(byContent('Run gate').assertionStatus,'inferred');assert.equal(byContent('Pixel').assertionStatus,'inferred');
 assert.equal(byContent('Design SOT').isAnchor,true);assert.ok(byContent('Design SOT').keywords.includes('anchor:SOT_LOCATION'));
});
test('lead edits are re-checked before saving',async t=>{
 await fakeAnchorMind(t);const f=withMemory(t);
 f.begin();const r=f.result();r.memory_candidates=[{type:'error',content:'Build failed'}];f.finish(r);
 const out=await commit(f.root,{accept:['m1'],edits:{m1:{content:'Build failed; token = abcd1234efgh'}}});
 assert.equal(out.results[0].status,'invalid');assert.match(out.results[0].problems.join(),/credential/);
 assert.equal(ledger(f).candidates[0].status,'pending');
});
test('recall returns workspace-scoped fragments ready for prior_experience, never rejected ones',async t=>{
 const mem=await fakeAnchorMind(t);const f=withMemory(t);
 mem.store.push({id:'a',workspace:'hyperfusion-test',type:'error',content:'bow-arm separation failed on both P4 drafts',assertionStatus:'verified'},
  {id:'b',workspace:'hyperfusion-test',type:'error',content:'bow-arm separation fixed by retopology',assertionStatus:'rejected'},
  {id:'c',workspace:'asset-pipeline',type:'error',content:'bow-arm separation in another project',assertionStatus:'verified'});
 const r=await recall(f.root,'bow-arm separation');
 assert.deepEqual(r.prior_experience,[{id:'a',type:'error',content:'bow-arm separation failed on both P4 drafts',assertion:'verified'}]);
 assert.equal(r.dropped_rejected,1);
 const call=mem.calls.find(c=>c.params?.name==='recall');assert.equal(call.params.arguments.text,'bow-arm separation');assert.equal(call.params.arguments.workspace,'hyperfusion-test');
});
test('prior_experience reaches the worker with its lower rank spelled out',async t=>{
 const f=withMemory(t);
 const prior=[{id:'a',type:'error',content:'PixelOEPixelize+ raised ModuleNotFoundError; do not retry the same setup',assertion:'verified'}];
 // 기각된 기억이나 비밀값은 lease를 잡기 전에 거절된다.
 assert.throws(()=>f.begin({prior_experience:[{type:'error',content:'x',assertion:'rejected'}]}),/prior_experience/);
 assert.throws(()=>f.begin({prior_experience:[{type:'error',content:'login with password: hunter22'}]}),/prior_experience/);
 assert.equal(f.state().iteration,0);
 const d=f.begin({prior_experience:prior});
 const msg=JSON.parse(d.prompt);
 assert.deepEqual(msg.brief.prior_experience,prior);assert.ok(msg.instructions.some(i=>/ranks below this brief/.test(i)));
});
test('a bad access key fails loudly, and server tool schemas decide argument names',async t=>{
 await fakeAnchorMind(t,{key:'right'});process.env.HF_MEMORY_KEY='wrong';
 await assert.rejects(()=>new AnchorMind().context('w'),/access key/);
 process.env.HF_MEMORY_KEY='right';
 const api=await new AnchorMind().connect();
 assert.throws(()=>api.shape('recall',{workspace:'w'},{}),/requires text/);
 assert.deepEqual(api.shape('recall',{workspace:'w',query:'q',bogus:1},{query:['text']}),{workspace:'w',text:'q'});
});
test('context returns anchors for the workspace',async t=>{
 const mem=await fakeAnchorMind(t);const f=withMemory(t);
 mem.store.push({id:'z',workspace:'hyperfusion-test',type:'fact',content:'GIT_REPO is prentice7725/hyperfusion',isAnchor:true});
 assert.equal((await context(f.root)).core.anchors[0].id,'z');
});
