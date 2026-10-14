import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
fs.mkdirSync('.build',{recursive:true});
if(fs.existsSync('Task.java')){
 const compile=spawnSync('javac',['-d','.build','Task.java','Acceptance.java'],{encoding:'utf8',timeout:30000});
 if(compile.error||compile.status!==0){console.error('Toolchain/compile failure');process.exit(2);}
 const result=spawnSync('java',['-cp','.build','Acceptance'],{encoding:'utf8',timeout:10000});
 if(result.error||result.signal){console.error('Java execution unavailable');process.exit(2);}
 if(result.status!==0){console.error(result.stderr);process.exit(/AssertionError/.test(result.stderr)?1:2);}
 if(fs.existsSync('pom.xml')){
  const spring=spawnSync(process.platform==='win32'?'mvn.cmd':'mvn',['-q','test'],{encoding:'utf8',timeout:90000,shell:process.platform==='win32'});
  if(spring.error||spring.signal){console.error('Maven/Spring execution unavailable');process.exit(2);}
  if(spring.status!==0){console.error(spring.stderr);process.exit(2);}
 }
}else{
 try{await import('./acceptance-case.mjs');}catch(e){console.error(e.message);process.exit(1);}
}
console.log('acceptance pass');
