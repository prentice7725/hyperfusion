import fs from 'node:fs';export function save(file,text,fail=false){fs.writeFileSync(file,'');if(fail)throw Error('simulated write failure');fs.writeFileSync(file,text);}
