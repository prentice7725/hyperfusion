import fs from 'node:fs';
import {phaseTable,PHASES} from './state-policy.mjs';
const file=new URL('../references/state-actions.md',import.meta.url);
const text='# State action policy\n\nGenerated from `scripts/state-policy.mjs`. Do not edit the table manually.\n\n'+phaseTable()+'\n\n`consult` with mode `review` and `delegate-review` require REVIEW. `consult-finish` also requires an open consult. `init` accepts an empty repository state or a terminal phase. `archive` requires quiescence and any held writer token. Status and report never mutate task phase.\n';
const schemaFile=new URL('../references/state-schema.json',import.meta.url),schema=JSON.parse(fs.readFileSync(schemaFile,'utf8'));
if(process.argv.includes('--check')){
 if(!fs.existsSync(file)||fs.readFileSync(file,'utf8').replaceAll('\r\n','\n')!==text||JSON.stringify(schema.properties.phase.enum)!==JSON.stringify(PHASES))throw Error('State documentation/schema is stale; run npm run docs:states');
}else{fs.writeFileSync(file,text);schema.properties.phase.enum=PHASES;fs.writeFileSync(schemaFile,JSON.stringify(schema,null,2)+'\n');}
