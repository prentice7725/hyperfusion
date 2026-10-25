import test from 'node:test';
import assert from 'node:assert/strict';
import {failureExcerpt,TAIL_CHARS} from '../scripts/output-excerpt.mjs';
import {supervisedCommands} from '../scripts/acceptance-runner.mjs';
import {failureFeedback} from '../scripts/acceptance.mjs';

const pad=n=>Array.from({length:n},(_,i)=>`ok ${i} - passing case with some padding text`).join('\n');

test('the first failure before the stored tail is kept with a bounded number of following lines',()=>{
 const text=['ok 1','not ok 2 - AC1 rejects empty token','  expected: 400','  actual: 200',pad(200)].join('\n');
 const e=failureExcerpt(text);
 assert.equal(e.line,2);assert.match(e.text,/^not ok 2 - AC1 rejects empty token\n  expected: 400\n  actual: 200/);
 assert.ok(e.text.split('\n').length<=20&&e.text.length<=2000);
 assert.equal(failureExcerpt(pad(200)),null,'no failure-looking line');
 assert.equal(failureExcerpt('not ok 1 - short output'),null,'everything is already in the tail');
 assert.equal(failureExcerpt(pad(10)+'\n'+'x'.repeat(TAIL_CHARS)+'\nnot ok 9 - inside tail'),null,'a failure inside the tail is not duplicated');
});

test('a failing acceptance command records the early failure and passes it to the next round',async()=>{
 const script="console.log('not ok 1 - AC2 early failure');for(let i=0;i<300;i++)console.log('ok '+i+' - padding padding padding');process.exit(1)";
 const [r]=await supervisedCommands(process.cwd(),[`node -e "${script}"`],{timeout_ms:60000});
 assert.equal(r.status,'fail');assert.equal(r.output_tail.length,TAIL_CHARS);
 assert.equal(r.output_failure_line,1);assert.match(r.output_failure_excerpt,/^not ok 1 - AC2 early failure/);
 assert.match(failureFeedback([r])[0],/First failure before the tail \(output line 1\):\nnot ok 1 - AC2 early failure/);
 const [ok]=await supervisedCommands(process.cwd(),[`node -e "console.log('error count: 0')"`],{timeout_ms:60000});
 assert.equal(ok.status,'pass');assert.equal('output_failure_excerpt' in ok,false,'passing commands keep the old record shape');
});
