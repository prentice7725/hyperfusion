import fs from 'node:fs';

export function readInput(file) {
 if(!file)return {};
 return JSON.parse(fs.readFileSync(file==='-'?0:file,'utf8').replace(/^\uFEFF/,''));
}

export function errorRecord(error) {
 const message=error.message??String(error);
 const code=error.code??message.match(/^([A-Z][A-Z0-9_]+):/)?.[1]??'OPERATION_FAILED';
 const actions={ADAPTER_UNAVAILABLE:'Check CLI installation and required options, then retry.',
  INVALID_PHASE:'Run status --summary and choose an allowed action.',
  LOCK_BUSY:'Retry shortly; inspect the lock owner if contention persists.',
  PROJECT_NOT_APPROVED:'Show the team report and record the user approval.',
  BUDGET_EXCEEDED:'Inspect report and task limits; no further worker launch is allowed.',
  MODEL_UNSUPPORTED:'Remove the model override or use a CLI supporting --model.'};
 return {code,message,next_action:error.next_action??actions[code]??'Inspect status and the error; correct the input or use the documented recovery procedure.'};
}
export function printError(error) {console.error(JSON.stringify(errorRecord(error)));process.exitCode=1;}
