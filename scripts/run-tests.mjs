import {spawnSync} from 'node:child_process';

// Windows CIM snapshots cover the whole host. Concurrent test files can leave
// short-lived processes without a visible parent and contaminate another
// acceptance supervisor's orphan check. Keep those files serialized; never
// relax the production quiescence gate to accommodate the test runner.
const concurrency=process.platform==='win32'?1:2;
// 일반 묶음은 테스트 전용 빈 프로세스 목록을 쓴다(Windows CIM 조회 한 번에 약 1초). 종료 증명을 검사하는
// 통합 테스트와 각 파일 안의 실제 목록 테스트는 HF_TEST_PROCESS_TABLE을 지우고 실제 조회를 쓴다.
// HF_TEST_PROCESS_TABLE=real npm test로 전체를 실제 조회로 돌릴 수 있다.
const mode=process.env.HF_TEST_PROCESS_TABLE==='real'?'real':'empty';
for(const [args,table] of [
 [['--test',`--test-concurrency=${concurrency}`],mode],
 [['--test','tests/acceptance-security.integration.mjs'],'real']
]){
 const result=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true,env:{...process.env,HF_TEST_PROCESS_TABLE:table}});
 if(result.error){console.error(result.error.message);process.exit(1);}
 if(result.status!==0)process.exit(result.status??1);
}
