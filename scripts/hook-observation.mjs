import fs from 'node:fs';
import {read,hash} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';
export function hookObservation(root,{at=Date.now(),sessionId=null,maxAgeMs=15000}={}) {
 const file=controlPath(root,'host-session.json');let row=null;
 try{if(fs.existsSync(file))row=read(file);}catch{}
 const stamp=Date.parse(row?.observed_at),age=at-stamp;
 const observed=Number.isFinite(age)&&age>=0&&age<=maxAgeMs&&row?.hook_event_name==='PreToolUse'&&row?.tool_name==='Bash'
  &&(!sessionId||row.session===hash(sessionId));
 return {hooks_observed:observed,observed_at:row?.observed_at??null,age_ms:Number.isFinite(age)&&age>=0?age:null,
  basis:'Recent Bash PreToolUse usage-hook event; does not prove every guard is installed or enforced',
  warning:observed?null:'HOOKS_NOT_OBSERVED: no recent Bash PreToolUse event; check the host hook settings. Standalone CLI hosts may have no hook integration.'};
}
