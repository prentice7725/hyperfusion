import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {recordRetrieval,collectMemory,assessMemory} from '../scripts/memory-observations.mjs';
import {measure} from '../scripts/metrics.mjs';

test('retrieval, exact brief inclusion and reported usefulness remain distinct',t=>{
 const f=fixture(t),task=f.brief.task_id;
 const item={id:'f1',type:'procedure',content:'Check compiler diagnostics'};
 const unseen=collectMemory(f.root,f.state());
 assert.equal(unseen.retrieval_events,null);assert.equal(unseen.brief_inclusions,0);assert.equal(unseen.usefulness,'unknown');
 const retrieval_id=recordRetrieval(f.root,task,'test-workspace',[item]);
 let result=collectMemory(f.root,f.state());
 assert.equal(result.retrieval_events,1);assert.equal(result.retrieved_items,1);assert.equal(result.brief_inclusions,0);assert.equal(result.helpful,0);
 const assessment={task,retrieval_id,id:'f1',round:1,outcome:'helpful',evidence:'The diagnostics identified the missing import.'};
 assert.throws(()=>assessMemory(f.root,assessment,'test-workspace'),/NOT_INCLUDED/);
 const brief=path.join(f.control,'tasks',task,'brief-1.json');
 fs.writeFileSync(brief,JSON.stringify({prior_experience:[{...item,content:'Different compiler lesson'}]}));
 assert.throws(()=>assessMemory(f.root,assessment,'test-workspace'),/NOT_INCLUDED/);
 fs.writeFileSync(brief,JSON.stringify({prior_experience:[item]}));
 assert.throws(()=>assessMemory(f.root,assessment,'another-workspace'),/UNRETRIEVED/);
 assert.throws(()=>assessMemory(f.root,{...assessment,evidence:'token = abcdef123456'},'test-workspace'),/Invalid/);
 assessMemory(f.root,assessment,'test-workspace');
 assessMemory(f.root,{...assessment,outcome:'unhelpful',evidence:'The workaround did not change the failure.'},'test-workspace');
 result=collectMemory(f.root,{...f.state(),iteration:1});
 assert.equal(result.brief_inclusions,1);assert.equal(result.assessments.length,1);assert.equal(result.helpful,0);assert.equal(result.unhelpful,1);
 assert.match(result.usefulness,/not causal/);
 assert.equal(measure(f.root).memory.retrieval_events,1);
 const saved=JSON.parse(fs.readFileSync(path.join(f.control,'tasks',task,'memory-observations.json')));
 assert.ok(!JSON.stringify(saved.retrievals).includes(item.content));
 assert.throws(()=>recordRetrieval(f.root,'../escape','test-workspace',[]),/task_id/);
});

test('similar words and equivalent meaning do not substitute for the retrieved evidence',t=>{
 const f=fixture(t),task=f.brief.task_id;
 const item={id:'f1',type:'error',content:'Disable the cache to avoid stale output'};
 const retrieval_id=recordRetrieval(f.root,task,'workspace',[item]);
 const brief=path.join(f.control,'tasks',task,'brief-1.json');
 for(const content of ['Enable the cache to avoid stale output','Turn caching off to prevent outdated results']){
  fs.writeFileSync(brief,JSON.stringify({prior_experience:[{...item,content}]}));
  assert.throws(()=>assessMemory(f.root,{task,retrieval_id,id:'f1',round:1,outcome:'helpful',evidence:'Reviewed the change.'},'workspace'),/NOT_INCLUDED/);
 }
});
