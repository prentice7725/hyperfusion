import {spawnSync} from 'node:child_process';

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
for(const args of [
 ['--test',`--test-concurrency=${concurrency}`,'--test-reporter=tap',...(shard?[`--test-shard=${shard}`]:[])],
 ...(!m||m[1]===m[2]?[['--test','--test-reporter=tap','tests/acceptance-security.integration.mjs']]:[])
]){
 // Herdr 안에서 npm test를 돌려도 시험 프로세스가 실제 관측 pane을 열지 않게 한다.
 const result=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true,env:{...process.env,HYPERFUSION_HERDR:'0'}});
 if(result.error){console.error(result.error.message);process.exit(1);}
 if(result.status!==0)process.exit(result.status??1);
}
