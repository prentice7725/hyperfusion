import {isIP} from 'node:net';

const placeholder=kind=>`[REDACTED:${kind}]`;
const SECRET_FIELD=/^(?:[\w.-]+[_-])?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|private[_-]?key)$/i;
export const isSecretField=key=>SECRET_FIELD.test(key);
const CONTROL_FIELD=new Set(['task_id','repo_root','round','id','member','file','files_read','files_changed','changed_files','paths','executor_bash_rules']);

// 이미지 해상도 표기 파일명(icon@16.png, logo@2x.png, hero@1.5x.webp)은 이메일이 아니다. 도메인 자리가 "해상도 표기.이미지 확장자"이고,
// png 같은 확장자는 최상위 도메인이 아니라서 이 모양의 주소는 존재할 수 없다. 이메일로 오인하면 파일 경로가 통째로 지워져
// 일꾼이 어느 파일인지 모르게 되고, scope.paths·files_changed에서는 "rename it before dispatch"로 디스패치가 막힌다.
// 좁게 잡는다: alice@example.com.txt처럼 실제 이메일이 든 파일명은 그대로 마스킹한다.
const DENSITY_IMAGE_DOMAIN=/^\d+(?:\.\d+)?x?\.(?:png|apng|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|heic|heif|svg|jxl)$/i;
const isImageDensityName=match=>DENSITY_IMAGE_DOMAIN.test(match.slice(match.lastIndexOf('@')+1));

// Korean and Japanese personal identifiers. Matching runs on a folded copy of the text in which full-width digits and
// letters, dash-like characters (including the katakana long mark often typed in phone numbers), the ideographic space and
// the full-width plus become ASCII. Every folded character is one UTF-16 unit, so match offsets map onto the original text.
const fold=s=>s
 .replace(/[０-９Ａ-Ｚａ-ｚ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0))
 .replace(/[‐-―−ー－ｰ]/g,'-').replace(/　/g,' ').replace(/＋/g,'+');
// Numbers glued to ASCII words, hex hashes or longer digit/dash runs are not identifiers. Hangul and kana may touch them.
const B='(?<![A-Za-z0-9_-])',E='(?![A-Za-z0-9_-])';
const digitsOf=s=>s.replace(/\D/g,'');
const KEYWORD_WINDOW=30;
const KEYWORDS={
 rrn:/주민|외국인\s*등록|resident|\brrn\b/i,
 myNumber:/マイナンバー|個人番号|my[\s_-]?number/i,
 account:/계좌|은행|국민|신한|우리|하나|농협|기업|카카오뱅크|토스|우체국|새마을|수협|SC제일|口座|銀行|普通|当座|預金|支店|ゆうちょ|信用金庫|account|bank/i,
 jpAccount:/口座|普通|当座|預金|ゆうちょ/,
 passport:/여권|旅券|パスポート|passport/i,
 driver:/면허|免許|driver|licen[cs]e/i,
 pension:/年金|pension/i,
};
const validDate=(century,yy,mm,dd)=>{
 const y=century+yy,d=new Date(Date.UTC(y,mm-1,dd));
 return d.getUTCFullYear()===y&&d.getUTCMonth()===mm-1&&d.getUTCDate()===dd;
};
// 주민·외국인등록번호: date from the gender digit's century. Numbers issued since October 2020 have random trailing digits,
// so the checksum is only demanded for a bare 13-digit run with no keyword nearby.
const RRN_WEIGHTS=[2,3,4,5,6,7,8,9,2,3,4,5];
const rrnChecksumOk=d=>{
 const check=(11-RRN_WEIGHTS.reduce((s,w,i)=>s+w*Number(d[i]),0)%11)%10;
 return Number(d[12])===check||('5678'.includes(d[6])&&Number(d[12])===(check+2)%10);
};
// 個人番号 検査用数字: P_n is the n-th digit from the right of the first 11, Q_n = n+1 (n<=6) or n-6 (n>=7).
const myNumberOk=d=>{
 let s=0;for(let n=1;n<=11;n++)s+=Number(d[11-n])*(n<=6?n+1:n-6);
 const r=s%11;return Number(d[11])===(r<=1?0:11-r);
};
const luhnOk=d=>{
 let s=0;for(let i=0;i<d.length;i++){let x=Number(d[d.length-1-i]);if(i%2){x*=2;if(x>9)x-=9;}s+=x;}
 return s%10===0;
};
const CARD_BRANDS=[
 [d=>d[0]==='4',[16,19]],
 [d=>(+d.slice(0,2)>=51&&+d.slice(0,2)<=55)||(+d.slice(0,4)>=2221&&+d.slice(0,4)<=2720),[16]],
 [d=>['34','37'].includes(d.slice(0,2)),[15]],
 [d=>+d.slice(0,4)>=3528&&+d.slice(0,4)<=3589,[16,19]],
 [d=>d.slice(0,2)==='62',[16,17,18,19]],
 [d=>d.slice(0,4)==='6011'||d.slice(0,2)==='65'||(+d.slice(0,3)>=644&&+d.slice(0,3)<=649),[16,19]],
 [d=>(+d.slice(0,3)>=300&&+d.slice(0,3)<=305)||d.slice(0,2)==='36',[14,16]],
 [d=>d[0]==='9',[16]],
];
const cardOk=d=>d.length>=14&&d.length<=19&&luhnOk(d)&&CARD_BRANDS.some(([brand,lengths])=>brand(d)&&lengths.includes(d.length));
const KR_LICENSE_REGIONS=new Set(['11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','28']);
// Order matters: each pass sees the previous placeholders, so specific shapes go before the keyword-only fallbacks.
const PII_RULES=[
 ['rrn',new RegExp(B+String.raw`(\d{6})([- ]?)([1-8]\d{6})`+E,'g'),(m,near)=>{
  const g=m[3][0],century='1256'.includes(g)?1900:2000;
  if(!validDate(century,+m[1].slice(0,2),+m[1].slice(2,4),+m[1].slice(4,6)))return false;
  return m[2]!==''||rrnChecksumOk(m[1]+m[3])||near(KEYWORDS.rrn);
 }],
 // 4-4-4 grouping alone is not enough: an unrelated 12-digit number passes the check digit one time in eleven.
 ['my-number',new RegExp(B+String.raw`\d{4}([- ]?)\d{4}\1\d{4}`+E,'g'),(m,near)=>near(KEYWORDS.myNumber)||(m[1]!==''&&myNumberOk(digitsOf(m[0])))],
 ['card',new RegExp(B+String.raw`(?:\d{14,19}|\d{4}([- ])\d{4,6}(?:\1\d{3,5}){1,3})`+E,'g'),m=>cardOk(digitsOf(m[0]))],
 ['phone',/(?<![\w+])\+8[12](?:[- .]?\(?0?\)?[- .]?\d{1,4}){2,4}(?![\w-])/g,m=>{const n=digitsOf(m[0]).replace(/^8[12]0?/,'').length;return n>=8&&n<=11;}],
 ['phone',new RegExp(B+String.raw`0(?:10|[5789]0)(?:([-. ])\d{4}\1\d{4}|\d{8})`+E,'g')],
 ['phone',new RegExp(B+String.raw`01[16789](?:([-. ])\d{3,4}\1\d{4}|\d{7,8})`+E,'g')],
 ['phone',new RegExp(B+String.raw`0(?:2|3[1-3]|4[1-4]|5[1-5]|6[1-4])(?:([-. ])\d{3,4}\1\d{4}|\d{7,8})`+E,'g')],
 // Japanese landlines: area code and local exchange vary in length, the total is ten digits.
 ['phone',new RegExp(B+String.raw`0\d{1,4}([-. ])\d{1,4}\1\d{4}`+E,'g'),m=>digitsOf(m[0]).length===10],
 ['phone',new RegExp(B+String.raw`0\d{1,4}\(\d{1,4}\)\d{4}`+E,'g'),m=>digitsOf(m[0]).length===10],
 ['driver-license',new RegExp(B+String.raw`(\d{2})-\d{2}-\d{6}-\d{2}`+E,'g'),m=>KR_LICENSE_REGIONS.has(m[1])],
 ['driver-license',new RegExp(B+String.raw`\d{12}`+E,'g'),(m,near)=>near(KEYWORDS.driver)],
 ['bank-account',new RegExp(B+String.raw`\d{2,8}(?:-\d{2,8}){1,3}`+E,'g'),(m,near)=>{const n=digitsOf(m[0]).length;return n>=10&&n<=14&&near(KEYWORDS.account);}],
 ['bank-account',new RegExp(B+String.raw`\d{7}`+E,'g'),(m,near)=>near(KEYWORDS.jpAccount)],
 ['passport',/(?<![A-Za-z0-9])[A-Z](?:\d{8}|\d{3}[A-Z]\d{4}|[A-Z]\d{7})(?![A-Za-z0-9])/g,(m,near)=>near(KEYWORDS.passport)],
 // 在留カード番号: two letters, eight digits, two letters. Distinctive enough to need no keyword.
 ['residence-card',/(?<![A-Za-z0-9])[A-Z]{2}\d{8}[A-Z]{2}(?![A-Za-z0-9])/g],
 ['pension-number',new RegExp(B+String.raw`\d{4}-?\d{6}`+E,'g'),(m,near)=>near(KEYWORDS.pension)],
];

// Transport-only filtering. Local provenance artifacts stay unchanged; audit never stores originals.
// `context` is the field name a value came from, so {"passport":"M12345678"} counts as having its keyword nearby.
export function redactText(text,counts={}, {preserveLines=false,context=''}={}) {
 // Evidence pointers refer to raw string line numbers, including masked blocks.
 const replacement=(match,masked)=>preserveLines
  ?masked+'\n'.repeat(Math.max(0,(match.match(/\n/g)??[]).length-(masked.match(/\n/g)??[]).length))
  :masked;
 if(text.length>8*1024*1024)throw Object.assign(Error('Redaction text size limit exceeded'),{code:'REDACTION_UNSAFE'});
 const replace=(kind,pattern,filter=()=>true)=>{
  text=text.replace(pattern,match=>{
   if(!filter(match))return match;
   counts[kind]=(counts[kind]??0)+1;
   return replacement(match,placeholder(kind));
  });
 };
 replace('private-key',/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g);
 replace('api-key',/\b(?:sk-(?:ant-api\d+-|proj-)?[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g);
 replace('token',/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g);
 text=text.replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/@]+:[^\s/@]+)@/gi,(m,p)=>{
  counts.secret=(counts.secret??0)+1;return replacement(m,p+placeholder('secret')+'@');
 });
 text=text.replace(/(\bBearer\s+)([A-Za-z0-9._~+\/-]+=*)/gi,(m,p)=>{
  counts.token=(counts.token??0)+1;return replacement(m,p+placeholder('token'));
 });
 // Quoted JSON/shell/diff assignments, including spaces inside quoted passwords.
 text=text.replace(/(\\"(?:[\w.-]{1,64}[_-])?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization)\\"\s*:\s*\\")[\s\S]*?(\\")/gi,(m,p,end)=>{
  counts.secret=(counts.secret??0)+1;return replacement(m,p+placeholder('secret')+end);
 });
 text=text.replace(/((?:["']?\b(?:[\w.-]{1,64}[_-])?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization)\b["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}&]+)/gi,(m,p,v)=>{
  // A preceding pass may have masked only part of this value. Mask the whole
  // assignment even when it already contains a placeholder (including user input).
  counts.secret=(counts.secret??0)+1;
  const quote=/^["']/.test(v)?v[0]:'';
  return replacement(m,p+quote+placeholder('secret')+quote);
 });
 replace('email',/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?\.[A-Za-z]{2,63}/g,match=>!isImageDensityName(match));
 // Keywords are checked on both forms: folding turns the long mark in マイナンバー into a dash, and Ｐａｓｓｐｏｒｔ into ASCII.
 const has=(keyword,s)=>keyword.test(s)||keyword.test(fold(s));
 for(const [kind,pattern,accept=()=>true] of PII_RULES){
  const folded=fold(text);let out='',last=0;
  for(const m of folded.matchAll(pattern)){
   const near=keyword=>has(keyword,String(context))||has(keyword,text.slice(Math.max(0,m.index-KEYWORD_WINDOW),m.index));
   if(!accept(m,near))continue;
   const end=m.index+m[0].length;
   out+=text.slice(last,m.index)+replacement(text.slice(m.index,end),placeholder(kind));last=end;
   counts[kind]=(counts[kind]??0)+1;
  }
  text=out+text.slice(last);
 }
 // IPv6, including compressed and IPv4-mapped forms. Validate candidates to avoid model/version matches.
 replace('ip',/(?<![\w:])(?:[A-Fa-f0-9]{0,4}:){2,7}(?:(?:\d{1,3}\.){3}\d{1,3}|[A-Fa-f0-9]{1,4})?(?:%[\w.-]+)?(?![\w:])/g,v=>isIP(v.split('%')[0])===6);
 replace('ip',/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,v=>isIP(v)===4);
 return text;
}

export function redactValue(value,counts={},protectedValue=false,depth=0,context='') {
 if(depth>80)throw Object.assign(Error('Redaction input nesting limit exceeded'),{code:'REDACTION_UNSAFE'});
 if(typeof value==='string'){
  // Embedded JSON strings are common in previous results and diff snippets.
  let masked;
  try {
   const parsed=JSON.parse(value);
   if(parsed&&typeof parsed==='object')masked=JSON.stringify(redactValue(parsed,counts,protectedValue,depth+1,context));
  }catch(e){if(e.code==='REDACTION_UNSAFE')throw e;}
  masked??=redactText(value,counts,{context});
  if(protectedValue&&masked!==value)throw Object.assign(Error('Sensitive data in a required transport identifier or path; rename it before dispatch'),{code:'REDACTION_UNSAFE'});
  return masked;
 }
 if(Array.isArray(value))return value.map(v=>redactValue(v,counts,protectedValue,depth+1,context));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>{
  const key=redactText(k,counts);
  if(key!==k)throw Object.assign(Error('Sensitive data in a transport field name'),{code:'REDACTION_UNSAFE'});
  if(isSecretField(k)&&v!==null&&v!==undefined&&v!==''){
   counts.secret=(counts.secret??0)+1;return [k,placeholder('secret')];
  }
  return [k,redactValue(v,counts,protectedValue||CONTROL_FIELD.has(k),depth+1,k)];
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
