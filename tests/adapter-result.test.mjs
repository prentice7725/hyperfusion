import test from 'node:test';
import assert from 'node:assert/strict';
import {extractResult,resultSchema,consultSchema,prompt,ACCEPTANCE,RUN_TESTS} from '../scripts/adapters/common.mjs';
import {commandOrders as claudeOrders} from '../scripts/adapters/claude.mjs';
import {strictSchema} from '../scripts/adapters/codex.mjs';
import {commandOrders,currentResult,dispatch as agyDispatch} from '../scripts/adapters/antigravity.mjs';

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
 const order=p.instructions.find(x=>/auto-denies/.test(x));
 assert.match(order,/"npm test", "git diff"/);
 assert.match(order,/Never run any other shell command/);
});
test('Antigravity prompt forbids shell commands when the brief allows none, and consults are untouched',()=>{
 assert.ok(JSON.parse(commandOrders(base,[],{})).instructions.some(x=>/Run no shell commands at all/.test(x)));
 assert.equal(commandOrders(base,[],{consult:{id:'c'}}),base);
});
test('Antigravity rounds run commands synchronously and leave acceptance commands to the controller',()=>{
 const withTests=JSON.parse(commandOrders(JSON.stringify({instructions:['existing order',ACCEPTANCE]}),['Bash(npm test*)'],{acceptance_commands:['npm test']}));
 assert.ok(!withTests.instructions.includes(ACCEPTANCE));
 assert.ok(withTests.instructions.some(x=>/foreground and wait until it exits/.test(x)));
 assert.ok(withTests.instructions.some(x=>/Do not run brief\.acceptance_commands yourself/.test(x)));
 const without=JSON.parse(commandOrders(base,[],{}));
 assert.ok(without.instructions.some(x=>/never wait for a completion notification/.test(x)));
 assert.ok(!without.instructions.some(x=>/acceptance_commands/.test(x)));
});
test('only Codex reviewers are told they may run read-only shell commands',()=>{
 const brief={task_id:'t',consult:{id:'c1',member:'m1',mode:'review'}};
 const text=owner=>JSON.parse(prompt(brief,{owner})).instructions.join('\n');
 for(const owner of ['sol','luna']){
  assert.match(text(owner),/Do not create, edit, move or delete any file/);
  assert.match(text(owner),/MAY run read-only commands such as cat.*rg.*git diff/);
 }
 // agy는 헤드리스에서 셸 명령이 자동 거부되어 빈 응답으로 끝난다. 파일 보기 도구만 쓰게 한다.
 const agy=text('antigravity');
 assert.match(agy,/using only your file view tools/);
 assert.match(agy,/Run no shell commands at all/);
 assert.doesNotMatch(agy,/MAY run read-only commands/);
 for(const owner of ['sonnet','haiku','grok']){
  assert.doesNotMatch(text(owner),/MAY run read-only commands/);
  assert.match(text(owner),/file read tools/);
 }
});
test('every const and enum in the result schemas carries a type, which OpenAI strict mode requires',()=>{
 const missing=(node,path='$')=>{
  if(Array.isArray(node))return node.flatMap((x,i)=>missing(x,`${path}[${i}]`));
  if(!node||typeof node!=='object')return [];
  const own=('const' in node||'enum' in node)&&!node.type?[path]:[];
  return [...own,...Object.entries(node).flatMap(([k,v])=>missing(v,`${path}.${k}`))];
 };
 const implement=resultSchema('t',3),consult=consultSchema({task_id:'t',consult:{id:'c1',member:'m1',mode:'review'}});
 const advisor=consultSchema({task_id:'t',consult:{id:'c1',member:'m1',mode:'advisor'}});
 for(const schema of [implement,consult,advisor,strictSchema(implement),strictSchema(consult)])assert.deepEqual(missing(schema),[]);
 assert.equal(implement.properties.task_id.type,'string');
 assert.equal(implement.properties.round.type,'integer');
 assert.equal(consult.properties.consult_id.type,'string');
 assert.equal(consult.properties.member.type,'string');
});
test('Antigravity never accepts a previous run\'s structured_output as the current result',()=>{
 const req={task_id:'t',round:2};
 const r1={task_id:'t',round:1,status:'complete'},r2={task_id:'t',round:2,status:'complete'};
 assert.deepEqual(currentResult({structured_output:r2,response:'done'},req),r2);
 assert.deepEqual(currentResult({structured_output:r1,response:JSON.stringify(r2)},req),r2);
 assert.throws(()=>currentResult({structured_output:r1,response:'done'},req),/belongs to round 1/);
 assert.throws(()=>currentResult({structured_output:r1,response:JSON.stringify(r1)},req),/belongs to round 1/);
 // 상담은 consult_id와 member로 맞춘다.
 const c={task_id:'t',consult_id:'c2',member:'m1'};
 assert.throws(()=>currentResult({structured_output:{...c,consult_id:'c1'},response:'x'},{task_id:'t',round:2,consult_id:'c2',member:'m1'}),/belongs to consult c1/);
 assert.deepEqual(currentResult({structured_output:c,response:'x'},{task_id:'t',round:2,consult_id:'c2',member:'m1'}),c);
});

// agy는 셸 권한이 없는 헤드리스로 돌고, 거부된 명령이 하나라도 있으면 결과 없이 끝난다.
// 공통 지시문의 "run the tests"가 그대로 가면 "셸을 쓰지 말라"는 지시와 부딪혀 테스트를 치려다 라운드를 날린다.
const agyBrief=extra=>({task_id:'T',round:1,repo_root:'/tmp/r',objective:'Add a test for X, then run npm test',scope:{paths:['src'],allowed_expansion:'ask-lead'},constraints:[],success_criteria:['AC1'],allowed_actions:['read','edit','test'],forbidden_actions:['commit','push'],evidence_required:[],...extra});
const agyInstructions=brief=>JSON.parse(agyDispatch(brief,{token:'x',owner:'antigravity',round:1},{session:null,resume:false,probe:{executable:'agy',prefix_args:[],supports:{'--model':true}},options:{}}).prompt).instructions;

test('Antigravity is never told to run the tests while its shell is closed',()=>{
 for(const brief of [agyBrief({}),agyBrief({acceptance_commands:[{id:'AC1',command:'npm test'}]}),agyBrief({executor_bash_rules:['Bash(git diff)']})]){
  const orders=agyInstructions(brief);
  assert.ok(!orders.some(x=>/run the tests, fix what fails/.test(x)),'the generic order that says run the tests is gone');
  assert.ok(orders.some(x=>/check it by reading the files you changed/.test(x)),'replaced by a reading-based order');
  assert.ok(orders.some(x=>/overrides any line in the objective, success criteria, constraints or lead_feedback/.test(x)),'a "run npm test" line in the brief does not win over the shell rule');
 }
});
test('Antigravity with an allow-list does not both allow and forbid the acceptance commands',()=>{
 const orders=agyInstructions(agyBrief({executor_bash_rules:['Bash(npm test)','Bash(git diff)'],acceptance_commands:[{id:'AC1',command:'npm test'}]}));
 const shell=orders.find(x=>/auto-denies any shell command outside the operator allow-list/.test(x));
 assert.match(shell,/"npm test", "git diff", and never the commands in brief\.acceptance_commands/);
});
test('other workers keep the original run-the-tests order',()=>{
 const text=JSON.parse(prompt(agyBrief({}),{owner:'grok'})).instructions.join('\n');
 assert.match(text,/Write the code, run the tests, fix what fails/);
});

// 실측에서 Haiku가 수용 명령에 파이프를 붙였다가 거부돼, 맞게 고친 라운드가 결과 없이 끝났다.
test('Claude workers are told which Bash commands they may run and that a refused call fails the round',()=>{
 const text=JSON.stringify({instructions:['existing order',RUN_TESTS,ACCEPTANCE]});
 const edit={allowed_actions:['read','edit','test'],acceptance_commands:['node --test tests/check.test.mjs']};
 const ruled=JSON.parse(claudeOrders(text,['Bash(node --test*)','Bash(git diff*)'],edit)).instructions;
 const order=ruled.at(-1);
 assert.match(order,/"node --test\*", "git diff\*"/);
 assert.match(order,/no pipes, redirects, 2>&1, ;, &&/);
 assert.match(order,/Any refused tool call fails the whole round/);
 assert.ok(ruled.includes(RUN_TESTS)&&ruled.includes(ACCEPTANCE),'allowed commands may still be run');
 // 규칙이 없으면 셸을 쓰지 말라고 하고, "직접 돌려 보라"는 문장을 바꾼다.
 const bare=JSON.parse(claudeOrders(text,[],edit)).instructions;
 assert.ok(!bare.includes(RUN_TESTS)&&!bare.includes(ACCEPTANCE));
 assert.ok(bare.some(x=>/You have no shell in this round: never call Bash/.test(x)));
 assert.ok(!bare.some(x=>/Run them yourself/.test(x)));
 // 상담과 읽기 전용 라운드는 그대로다.
 assert.equal(claudeOrders(text,[],{...edit,consult:{id:'c'}}),text);
 assert.equal(claudeOrders(text,[],{allowed_actions:['read']}),text);
});
