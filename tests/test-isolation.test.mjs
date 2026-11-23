import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {stateHome} from '../scripts/control-dir.mjs';
import {pacingDir} from '../scripts/worker-pacing.mjs';

// npm test(scripts/run-tests.mjs)와 npm run smoke는 이 컴퓨터의 실제 HyperFusion 기록을 쓰지 않는다.
// tests/support.mjs를 거치지 않는 시험(예: benchmark-large)도 ~/.hyperfusion/state에 제어 폴더를 남기지 않게 러너가 격리한다.
const real=path.join(os.homedir(),'.hyperfusion');
const inside=(dir,root)=>{const rel=path.relative(root,path.resolve(dir));return rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel));};

test('the test runner points state and pacing away from the real ~/.hyperfusion',()=>{
 assert.ok(!inside(stateHome(),real),`stateHome() is ${stateHome()}; run the suite through npm test so HF_STATE_DIR is isolated`);
 assert.ok(!inside(pacingDir(),real),`pacingDir() is ${pacingDir()}; run the suite through npm test so HF_PACING_DIR is isolated`);
 assert.equal(process.env.HF_TEAM_FILE,'off');
});
