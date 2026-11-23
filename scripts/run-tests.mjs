import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Windows CIM snapshots cover the whole host. Concurrent test files can leave
// short-lived processes without a visible parent and contaminate another
// acceptance supervisor's orphan check. Keep those files serialized; never
// relax the production quiescence gate to accommodate the test runner.
const concurrency=process.platform==='win32'?1:2;
// CI는 직렬로 도는 Windows 작업을 러너 여러 대로 나눈다(HF_TEST_SHARD=i/n). 러너는 서로 다른 호스트라
// 한 러너 안의 직렬 규칙은 그대로다. 통합 테스트는 마지막 조각에서 한 번만 돈다.
const shard=process.env.HF_TEST_SHARD?.trim()||null;
const m=shard?.match(/^(\d+)\/(\d+)$/);
if(shard&&!(m&&+m[1]>=1&&+m[1]<=+m[2])){console.error(`HF_TEST_SHARD must be i/n with 1<=i<=n (got ${shard})`);process.exit(1);}
// npm test -- tests/a.test.mjs처럼 파일을 주면 그 파일만 같은 격리 환경에서 돈다(통합 테스트는 건너뛴다).
const files=process.argv.slice(2);
// 제어 폴더(HF_STATE_DIR)는 실행마다 새 임시 폴더다. tests/support.mjs를 거치지 않는 시험도 ~/.hyperfusion/state에 기록을 남기지 않는다.
// 셸에 설정된 HF_STATE_DIR는 실제 기록일 수 있으므로 이어받지 않는다.
const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'hf-test-state-'));
let status=0;
try {
 for(const args of [
  ['--test',`--test-concurrency=${concurrency}`,'--test-reporter=tap',...(shard?[`--test-shard=${shard}`]:[]),...files],
  ...(!files.length&&(!m||m[1]===m[2])?[['--test','--test-reporter=tap','tests/acceptance-security.integration.mjs']]:[])
 ]){
  // Herdr 안에서 npm test를 돌려도 시험 프로세스가 실제 관측 pane을 열지 않게 한다. 이 컴퓨터의 팀 파일과 호출 조절 기록(~/.hyperfusion/pacing)도 쓰지 않는다.
  const result=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true,env:{...process.env,HYPERFUSION_HERDR:'0',HF_TEAM_FILE:'off',HF_STATE_DIR:stateDir,HF_PACING_DIR:process.env.HF_PACING_DIR??path.join(os.tmpdir(),'hf-test-pacing-'+process.pid)}});
  if(result.error){console.error(result.error.message);status=1;break;}
  if(result.status!==0){status=result.status??1;break;}
 }
} finally {
 fs.rmSync(stateDir,{recursive:true,force:true,maxRetries:5});
}
process.exit(status);
