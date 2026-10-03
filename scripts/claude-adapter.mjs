import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dispatch as lunaDispatch} from './luna-adapter.mjs';
export const requiredFlags=['--output-format','--json-schema','--resume','--session-id','--safe-mode','--tools','--allowedTools','--disallowedTools','--permission-mode','--max-turns'];
export function probeClaude(binary=process.env.HF_CLAUDE_BIN||'claude') {
 if(process.platform==='win32')throw Error('ADAPTER_UNAVAILABLE: M1 process supervision requires POSIX');
 const candidates=binary.includes('/')?[path.resolve(binary)]: (process.env.PATH||'').split(path.delimiter).map(d=>path.resolve(d,binary));
 const executable=candidates.find(f=>{try{fs.accessSync(f,fs.constants.X_OK);return fs.statSync(f).isFile();}catch{return false;}});
 if(!executable)throw Error('ADAPTER_UNAVAILABLE: Claude Code executable not found');
 const opts={encoding:'utf8',timeout:5000,maxBuffer:1024*1024};
 const version=execFileSync(executable,['--version'],opts).trim();
 const help=execFileSync(executable,['--help'],opts);
 const missing=requiredFlags.filter(f=>!help.includes(f));
 if(missing.length)throw Error('ADAPTER_UNAVAILABLE: missing Claude flags '+missing.join(', '));
 return {executable:fs.realpathSync(executable),version,authentication:'not verified by local probe'};
}
export function resultSchema(task_id,round) {
 const strings={type:'array',items:{type:'string'}};
 const properties={task_id:{const:task_id},round:{const:round},status:{enum:['complete','blocked','needs_decision','failed']},summary:{type:'string'},files_read:strings,files_changed:strings,commands_run:strings,tests:{type:'array',items:{type:'object',properties:{command:{type:'string'},status:{enum:['pass','fail','not_run']}},required:['command','status'],additionalProperties:false}},unresolved:strings,risks:strings,needs_lead_decision:{type:'boolean'},recommended_next_action:{type:'string'}};
 return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};
}
export function claudeDispatch(brief,lease,session,resume,probe) {
 // Reuse the exact logical contract without passing either model's prior transcript.
 const message=lunaDispatch(brief,lease).arguments.message;
 const bashRules=brief.claude_bash_rules??[];
 if(!Array.isArray(bashRules)||bashRules.some(r=>typeof r!=='string'||!/^Bash\([^(),\n]+\)$/.test(r)||r==='Bash(*)'))throw Error('Invalid claude_bash_rules');
 const allowed=['Read','Glob','Grep',...(brief.allowed_actions.includes('edit')?['Edit','Write']:[]),...bashRules];
 const args=['-p','--safe-mode','--output-format','json','--json-schema',JSON.stringify(resultSchema(brief.task_id,brief.round)),
 '--permission-mode','dontAsk','--tools',allowed.includes('Edit')?'Read,Glob,Grep,Edit,Write,Bash':'Read,Glob,Grep,Bash',
 '--allowedTools',allowed.join(','),'--disallowedTools','Agent,Task,Skill,mcp__*,Bash(git commit *),Bash(git push *),Bash(git reset *),Bash(git clean *),Bash(git stash *)',
 '--max-turns','40',resume?'--resume':'--session-id',session];
 return {transport:'claude-code',command:process.execPath,args:[fileURLToPath(new URL('./claude-bridge.mjs',import.meta.url)),brief.repo_root],
 cli:{...probe,args,session_id:session,resume},stdin:message,task_id:brief.task_id,round:brief.round,token:lease.token};
}
