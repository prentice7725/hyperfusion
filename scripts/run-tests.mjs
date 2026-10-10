import {spawnSync} from 'node:child_process';

// Windows CIM snapshots cover the whole host. Concurrent test files can leave
// short-lived processes without a visible parent and contaminate another
// acceptance supervisor's orphan check. Keep those files serialized; never
// relax the production quiescence gate to accommodate the test runner.
const concurrency=process.platform==='win32'?1:2;
for(const args of [
 ['--test',`--test-concurrency=${concurrency}`],
 ['--test','tests/acceptance-security.integration.mjs']
]){
 const result=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true});
 if(result.error){console.error(result.error.message);process.exit(1);}
 if(result.status!==0)process.exit(result.status??1);
}
