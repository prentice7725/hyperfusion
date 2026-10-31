// 보존(preserve) 검증 계약: 리팩터링처럼 수정 전에도 수용 명령이 통과하는 작업의 증거.
// red-first는 "명령이 틀린 결과를 가려낸다"는 증거였다. 보존 작업에서는 그 자리를 "보호 경로(테스트·픽스처)가 하나도 바뀌지 않았다"가 대신한다.
// 일꾼이 테스트를 약하게 고쳐서 통과시키는 길을 컨트롤러가 스냅샷으로 막는다. 모델은 호출하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {changes,git,hash} from './artifact.mjs';
import {globRegex} from './acceptance.mjs';

export const isPreserve=brief=>brief?.verification?.kind==='preserve';

// glob의 앞쪽 리터럴 디렉터리(와일드카드가 나오기 전까지). 'tests/**' → 'tests', '**/x' → ''.
const literalPrefix=glob=>{
 const parts=glob.split('/'),out=[];
 for(const p of parts){if(/[*?]/.test(p))break;out.push(p);}
 return out.join('/');
};

// 보호 경로와 작업 범위가 겹치면 일꾼이 보호 파일을 고치는 것이 곧 범위 안의 일이 된다. 겹침은 거절한다.
// 앞쪽이 와일드카드인 glob(예: **/*.test.mjs)은 범위 어디든 맞을 수 있어서 겹치는 것으로 본다.
export function scopeOverlap(scopePaths,protect) {
 const hits=[];
 for(const g of protect){
  const prefix=literalPrefix(g),re=globRegex(g);
  for(const p of scopePaths){
   const within=(a,b)=>a===b||a.startsWith(b+'/');
   if(prefix===''||within(prefix,p)||within(p,prefix)||re.test(p))hits.push(`${g} / ${p}`);
  }
 }
 return hits;
}

// init에서 호출: 보호 경로가 실제 파일에 맞는지(빈 보호는 보호가 아니다)와 범위와 겹치지 않는지.
export function checkPreserve(root,brief) {
 const {protect}=brief.verification;
 const overlap=scopeOverlap(brief.scope.paths,protect);
 if(brief.verification.kind==='preserve'&&overlap.length)throw Error(`VERIFICATION: protect overlaps the task scope (${overlap.slice(0,3).join('; ')}); protected files must be outside scope.paths`);
 const files=git(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean);
 const res=protect.map(g=>[g,globRegex(g)]);
 const empty=res.filter(([,re])=>!files.some(f=>re.test(f))).map(([g])=>g);
 if(empty.length)throw Error(`VERIFICATION: protect matches no file (${empty.join(', ')}); verification needs real tests or fixtures to protect`);
}

// 보호 경로에 맞는 실제 파일 목록(추적·미추적 모두).
export function protectedFiles(root,protect=[]) {
 if(!protect.length)return [];
 const files=git(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean);
 const res=protect.map(globRegex);
 return files.filter(f=>res.some(re=>re.test(f))).sort();
}

// 리뷰어에게 주는 수용 테스트 본문. 테스트는 리드가 일꾼보다 먼저 썼고 보호돼 있어 diff에는 나오지 않는다.
// 다른 계열의 리뷰어가 "테스트가 AC를 제대로 담았는가"를 보게 하려는 것이다(AC와 테스트를 같은 모델이 쓴 오해를 걸러 낸다).
// 길이는 상한(agy는 명령줄로 프롬프트를 받는다)으로 자르고, 잘린 파일은 직접 읽으라고 알린다.
export const ACCEPTANCE_TESTS_MAX=12000;
export function acceptanceTestsContext(root,brief,max=ACCEPTANCE_TESTS_MAX) {
 const protect=brief?.verification?.protect??[];
 if(!protect.length||!brief?.acceptance_commands?.length)return null;
 let budget=max;
 const files=protectedFiles(root,protect).map(file=>{
  let text;
  try{text=fs.readFileSync(path.join(root,file),'utf8');}catch{return {path:file,unreadable:true};}
  const shown=text.slice(0,Math.max(0,budget));budget-=shown.length;
  return {path:file,sha256:hash(text),...(shown.length<text.length?{content:shown,truncated:true}:{content:shown})};
 });
 return {kind:brief.verification.kind,commands:brief.acceptance_commands,files,
  note:'Protected acceptance tests: written before the worker started and unchanged since (the controller refuses any change). They do not appear in the diff. Judge whether they faithfully test the objective and every success criterion; read a truncated file directly.'};
}

// 작업을 시작했을 때(baseline)와 지금 사이에 보호 경로의 파일이 바뀌었는지. 라운드 단위가 아니라 작업 전체로 본다.
export function protectedChanges(baseline,now,protect) {
 const res=protect.map(globRegex);
 return changes(baseline,now).filter(f=>res.some(re=>re.test(f)));
}
