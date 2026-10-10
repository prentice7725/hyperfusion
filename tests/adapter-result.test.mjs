import test from 'node:test';
import assert from 'node:assert/strict';
import {extractResult,resultSchema,consultSchema} from '../scripts/adapters/common.mjs';
import {strictSchema} from '../scripts/adapters/codex.mjs';
import {commandOrders} from '../scripts/adapters/antigravity.mjs';

// grok 1.0.50 실측: 중간 설명과 최종 JSON이 구분 없이 이어진 text
const GROK_TEXT='I\'ll replace `hf-smoke.txt` with exactly `ok` and a newline, and leave everything else untouched.'
 +'{"task_id":"hf-smoke","round":1,"status":"complete","summary":"Replaced {braces} in \\"quotes\\"","files_changed":["hf-smoke.txt"]}';

test('extractResult accepts a JSON object glued to the end of prose',()=>{
 const v=extractResult(GROK_TEXT);
 assert.equal(v.task_id,'hf-smoke');
 assert.equal(v.summary,'Replaced {braces} in "quotes"');
});
test('extractResult still rejects prose without a trailing JSON object',()=>{
 assert.throws(()=>extractResult('All done, the file now says ok.'),/no result JSON/);
 assert.throws(()=>extractResult('Result {"task_id":"x"} and then more prose.'),/no result JSON/);
 assert.throws(()=>extractResult('Done. {"task_id":"x",'),/no result JSON/);
});
test('extractResult keeps whole-text and fenced-block precedence',()=>{
 assert.equal(extractResult('{"a":1}').a,1);
 assert.equal(extractResult('note {"a":1}\n```json\n{"a":2}\n```').a,2);
 assert.throws(()=>extractResult('```json\n{bad\n```'),/malformed/);
});

const objects=s=>!s||typeof s!=='object'?[]:[...(s.type==='object'&&s.properties?[s]:[]),...Object.values(s).flatMap(objects)];

test('Codex result schema lists every property as required at every depth',()=>{
 const strict=strictSchema(resultSchema('t',1));
 const all=objects(strict);
 assert.ok(all.length>=3);
 for(const o of all)assert.deepEqual([...o.required].sort(),Object.keys(o.properties).sort());
 assert.ok(strict.required.includes('memory_candidates'));
 assert.ok(strict.properties.memory_candidates.items.required.includes('keywords'));
});
test('strictSchema does not change the shared schema or an already strict consult schema',()=>{
 const base=resultSchema('t',1);
 strictSchema(base);
 assert.ok(!base.required.includes('memory_candidates'));
 const consult=consultSchema({task_id:'t',consult:{id:'c1',member:'sol',mode:'review'}});
 assert.deepEqual(strictSchema(consult),consult);
});
const base=JSON.stringify({instructions:['existing order']});

test('Antigravity prompt names the only commands it may run',()=>{
 const p=JSON.parse(commandOrders(base,['Bash(npm test*)','Bash(git diff*)'],{}));
 assert.equal(p.instructions[0],'existing order');
 const order=p.instructions.at(-1);
 assert.match(order,/"npm test", "git diff"/);
 assert.match(order,/Never run any other shell command/);
});
test('Antigravity prompt forbids shell commands when the brief allows none, and consults are untouched',()=>{
 assert.match(JSON.parse(commandOrders(base,[],{})).instructions.at(-1),/Run no shell commands at all/);
 assert.equal(commandOrders(base,[],{consult:{id:'c'}}),base);
});
