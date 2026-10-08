import {isIP} from 'node:net';

const placeholder=kind=>`[REDACTED:${kind}]`;
const SECRET_FIELD=/^(?:[\w.-]+[_-])?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|private[_-]?key)$/i;
const CONTROL_FIELD=new Set(['task_id','repo_root','round','id','member','file','files_read','files_changed','changed_files','paths','executor_bash_rules']);

// Transport-only filtering. Local provenance artifacts stay unchanged; audit never stores originals.
export function redactText(text,counts={}) {
 if(text.length>8*1024*1024)throw Object.assign(Error('Redaction text size limit exceeded'),{code:'REDACTION_UNSAFE'});
 const replace=(kind,pattern,filter=()=>true)=>{
  text=text.replace(pattern,match=>{
   if(!filter(match))return match;
   counts[kind]=(counts[kind]??0)+1;
   return placeholder(kind);
  });
 };
 replace('private-key',/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g);
 replace('api-key',/\b(?:sk-(?:ant-api\d+-|proj-)?[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g);
 replace('token',/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g);
 text=text.replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/@]+:[^\s/@]+)@/gi,(m,p)=>{
  counts.secret=(counts.secret??0)+1;return p+placeholder('secret')+'@';
 });
 text=text.replace(/(\bBearer\s+)([A-Za-z0-9._~+\/-]+=*)/gi,(m,p)=>{
  counts.token=(counts.token??0)+1;return p+placeholder('token');
 });
 // Quoted JSON/shell/diff assignments, including spaces inside quoted passwords.
 text=text.replace(/(\\"(?:[\w.-]{1,64}[_-])?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization)\\"\s*:\s*\\")[\s\S]*?(\\")/gi,(m,p,end)=>{
  counts.secret=(counts.secret??0)+1;return p+placeholder('secret')+end;
 });
 text=text.replace(/((?:["']?\b(?:[\w.-]{1,64}[_-])?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization)\b["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}&]+)/gi,(m,p,v)=>{
  if(v.includes('[REDACTED:'))return m;
  counts.secret=(counts.secret??0)+1;
  const quote=/^["']/.test(v)?v[0]:'';
  return p+quote+placeholder('secret')+quote;
 });
 replace('email',/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?\.[A-Za-z]{2,63}/g);
 // IPv6, including compressed and IPv4-mapped forms. Validate candidates to avoid model/version matches.
 replace('ip',/(?<![\w:])(?:[A-Fa-f0-9]{0,4}:){2,7}(?:(?:\d{1,3}\.){3}\d{1,3}|[A-Fa-f0-9]{1,4})?(?:%[\w.-]+)?(?![\w:])/g,v=>isIP(v.split('%')[0])===6);
 replace('ip',/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,v=>isIP(v)===4);
 return text;
}

export function redactValue(value,counts={},protectedValue=false,depth=0) {
 if(depth>80)throw Object.assign(Error('Redaction input nesting limit exceeded'),{code:'REDACTION_UNSAFE'});
 if(typeof value==='string'){
  // Embedded JSON strings are common in previous results and diff snippets.
  let masked;
  try {
   const parsed=JSON.parse(value);
   if(parsed&&typeof parsed==='object')masked=JSON.stringify(redactValue(parsed,counts,protectedValue,depth+1));
  }catch(e){if(e.code==='REDACTION_UNSAFE')throw e;}
  masked??=redactText(value,counts);
  if(protectedValue&&masked!==value)throw Object.assign(Error('Sensitive data in a required transport identifier or path; rename it before dispatch'),{code:'REDACTION_UNSAFE'});
  return masked;
 }
 if(Array.isArray(value))return value.map(v=>redactValue(v,counts,protectedValue,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>{
  const key=redactText(k,counts);
  if(key!==k)throw Object.assign(Error('Sensitive data in a transport field name'),{code:'REDACTION_UNSAFE'});
  if(SECRET_FIELD.test(k)&&v!==null&&v!==undefined&&v!==''){
   counts.secret=(counts.secret??0)+1;return [k,placeholder('secret')];
  }
  return [k,redactValue(v,counts,protectedValue||CONTROL_FIELD.has(k),depth+1)];
 }));
 return value;
}

export function maskTransport(request) {
 const counts={},masked=structuredClone(request);
 // All adapters derive their input from this JSON prompt. Preserve flags, schemas and tool rules.
 const prompt=JSON.stringify(redactValue(JSON.parse(request.prompt),counts));
 masked.prompt=prompt;
 if(request.stdin!==undefined){
  if(request.stdin!==request.prompt)throw Object.assign(Error('Unexpected executor stdin transport'),{code:'REDACTION_UNSAFE'});
  masked.stdin=prompt;
 }
 masked.cli.args=masked.cli.args.map(arg=>arg===request.prompt?prompt:arg);
 // Fail closed for control paths/schema/flags containing sensitive values rather than passing them raw.
 for(const field of ['executable','prefix_args','prompt_file','extra_files','args','session_id']){
  if(field==='args'){
   for(const arg of masked.cli.args)if(arg!==prompt)redactValue(arg,{},true);
  }else if(masked.cli[field]!==undefined)redactValue(masked.cli[field],{},true);
 }
 return {request:masked,audit:{enabled:true,counts,total:Object.values(counts).reduce((a,b)=>a+b,0)}};
}
