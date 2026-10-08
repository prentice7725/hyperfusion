import fs from 'node:fs';
import path from 'node:path';
import {read} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';
export function validateLimits(limits={}) {
 if(!limits||typeof limits!=='object'||Array.isArray(limits)||Object.keys(limits).some(k=>!['max_cost_usd','max_wall_ms'].includes(k)))throw Error('Invalid task limits');
 if(limits.max_cost_usd!==undefined&&!(typeof limits.max_cost_usd==='number'&&Number.isFinite(limits.max_cost_usd)&&limits.max_cost_usd>0))throw Error('Invalid max_cost_usd');
 if(limits.max_wall_ms!==undefined&&!(Number.isSafeInteger(limits.max_wall_ms)&&limits.max_wall_ms>0))throw Error('Invalid max_wall_ms');
 return {...limits};
}
export function budgetStatus(root,state,now=Date.now()) {
 const limits=state.limits??{},dir=controlPath(root,'tasks',state.task_id);
 const files=fs.existsSync(dir)?fs.readdirSync(dir):[];
 const usage=files.filter(f=>/^usage-.+\.json$/.test(f)).map(f=>read(path.join(dir,f)));
 const unreported=files.filter(f=>/^launch-.+\.json$/.test(f)&&!files.includes(f.replace(/^launch-/,'usage-')));
 const known=usage.filter(u=>typeof u.total_cost_usd==='number'&&Number.isFinite(u.total_cost_usd)&&u.total_cost_usd>=0);
 const known_cost_usd=known.reduce((sum,u)=>sum+u.total_cost_usd,0);
 const wall_ms=Math.max(0,now-Date.parse(state.started_at));
 const reason=limits.max_wall_ms!==undefined&&wall_ms>=limits.max_wall_ms?'max_wall_ms':limits.max_cost_usd!==undefined&&known_cost_usd>=limits.max_cost_usd?'max_cost_usd':null;
 return {limits,known_cost_usd,cost_complete:usage.length===known.length&&!unreported.length,wall_ms,reason,
  remaining_wall_ms:limits.max_wall_ms===undefined?null:Math.max(0,limits.max_wall_ms-wall_ms)};
}
export function assertBudget(root,state) {
 const status=budgetStatus(root,state);
 if(status.reason){const e=Error(`BUDGET_EXCEEDED: ${status.reason}`);e.code='BUDGET_EXCEEDED';throw e;}
 return status;
}
