// 리드 호스트와 리드 모델을 정한다. 리드 계열은 누가 리뷰어가 될 수 있는지를 정하므로 권한 입력으로 다룬다.
// 출처 순서: 호스트 훅이 남긴 관측값 → 운영자 환경변수 HF_LEAD_MODEL → 설정(저장소 설정은 claude-opus-*만 적을 수 있고, 호스트가 Claude Code일 때만 쓴다).
// 두 출처의 계열이 다르면 거절한다. 저장소 설정으로 리드 계열을 바꿀 수 없다.
import fs from 'node:fs';
import {read} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';
import {hookObservation} from './hook-observation.mjs';
import {familyOf,UNKNOWN} from './model-registry.mjs';

// 호스트가 제공하는 능력. verified는 실제 CLI로 훅 동작을 실측했는지다. 실측 전 호스트는 문서상 능력이 있어도 C로 둔다.
//   pre_block: 리드 쓰기를 PreToolUse로 막는다 / fail_closed: 훅 실패·시간 초과에 도구가 막힌다
//   model_identity: 호출마다 리드 모델을 알 수 있다 / model_lock: 작업 중 다른 계열로 전환을 막는다 / stop_block: 턴 종료를 막는다
export const HOSTS={
 'claude-code':{verified:true,capabilities:{pre_block:true,fail_closed:true,model_identity:true,model_lock:true,stop_block:true}},
 codex:{verified:false,capabilities:{pre_block:true,fail_closed:false,model_identity:true,model_lock:false,stop_block:true}},
 antigravity:{verified:false,capabilities:{pre_block:true,fail_closed:false,model_identity:true,model_lock:false,stop_block:true}}
};
export const GRADES=['A','B','C'];
export const LEAD_MODEL_ENV='HF_LEAD_MODEL';
export const LEAD_GRADE_ENV='HF_ALLOW_LEAD_GRADE';

export function hostGrade(host,{hooks_observed=false}={}) {
 const h=HOSTS[host];
 if(!h||!h.verified||!hooks_observed)return 'C';
 const c=h.capabilities;
 if(c.pre_block&&c.fail_closed&&c.model_identity&&c.model_lock&&c.stop_block)return 'A';
 if(c.pre_block&&c.model_identity)return 'B';
 return 'C';
}

const sessionRow=root=>{
 const file=controlPath(root,'host-session.json');
 try{return fs.existsSync(file)?read(file):null;}catch{return null;}
};

// 지금 관측된 리드 모델. 최근 훅 이벤트가 있고 그 세션이 모델을 보고했을 때만 값이 있다.
export function observedLead(root,{at=Date.now()}={}) {
 const hooks=hookObservation(root,{at});
 const row=hooks.hooks_observed?sessionRow(root):null;
 return {hooks,host:row?.host??null,model:typeof row?.lead_model==='string'?row.lead_model:null};
}

// init에서 한 번 정하고 작업 동안 고정한다(R7). configuration.lead_model은 설정 파일이 직접 적은 값인지 lead_model_source로 안다.
export function leadIdentity(root,configuration,{env=process.env,at=Date.now()}={}) {
 const {hooks,host,model:observed}=observedLead(root,{at});
 const operator=typeof env[LEAD_MODEL_ENV]==='string'&&env[LEAD_MODEL_ENV].trim()?env[LEAD_MODEL_ENV].trim():null;
 const configured=configuration?.lead_model??null;
 if(observed&&operator&&familyOf(observed)!==familyOf(operator))throw Error(`LEAD_IDENTITY_CONFLICT: the host reports ${observed} but ${LEAD_MODEL_ENV} is ${operator}`);
 // 설정값(기본 Opus)은 호스트가 Claude Code라는 근거가 있을 때만 쓴다. 근거가 없으면 Codex·agy 리드를 Claude 리드로 잘못 볼 수 있다.
 // 근거: 최근 훅이 Claude Code를 보고했거나, 훅 관측 없이 Claude Code가 셸에 넣는 CLAUDECODE=1이 있다.
 if(!observed&&!operator&&!(host==='claude-code'||!host&&env.CLAUDECODE==='1')){
  throw Error(`LEAD_MODEL_UNKNOWN: ${host?`the ${host} host hook reported no lead model`:'no host hook reported the lead model and this is not a Claude Code shell'}; check the host hook settings or have the operator set ${LEAD_MODEL_ENV} before starting the host`);
 }
 const model=observed??operator??configured;
 const source=observed?'host-hook':operator?'operator-env':'config';
 const family=familyOf(model);
 if(configuration?.lead_model_source==='config'&&familyOf(configured)!==family){
  throw Error(`LEAD_IDENTITY_CONFLICT: hyperfusion.config.json names ${configured} but the lead is ${model}; a repository config cannot choose the lead family`);
 }
 const compatible=family==='anthropic';
 let grade=hostGrade(host??(compatible?'claude-code':null),hooks);
 const raised=env[LEAD_GRADE_ENV];
 if(raised!==undefined&&raised!==''){
  if(!GRADES.includes(raised))throw Error(`${LEAD_GRADE_ENV} must be A, B or C`);
  if(GRADES.indexOf(raised)<GRADES.indexOf(grade))grade=raised;
 }
 return {host:host??(compatible?'claude-code':'unknown'),model,family,source,grade,hooks_observed:hooks.hooks_observed,
  // 등급에 따른 권한 축소는 비 Claude 리드에만 적용한다. Claude Code 리드는 지금의 경고(HOOKS_NOT_OBSERVED) 동작을 유지한다.
  enforced:!compatible,
  ...(family===UNKNOWN?{warning:'LEAD_FAMILY_UNKNOWN: the lead model is not in the registry; delegated approval is unavailable'}:{})};
}

// 비 Claude 리드의 등급이 허용하는 권한. A와 B만 위임 승인과 takeover를 받는다.
export function leadPowers(identity) {
 if(!identity?.enforced)return {delegation:true,takeover:true};
 const strong=identity.grade==='A'||identity.grade==='B';
 return {delegation:strong&&identity.family!==UNKNOWN,takeover:strong};
}

// 라운드마다 리드 계열이 기록과 같은지 본다(R7). 같은 계열 안의 모델 변경은 기록만 한다.
export function assertLeadFamily(root,identity,{at=Date.now()}={}) {
 if(!identity)return null;
 const now=observedLead(root,{at});
 if(now.model){
  if(familyOf(now.model)!==identity.family)throw Error(`LEAD_FAMILY_CHANGED: the task started with a ${identity.family} lead (${identity.model}) but the host now reports ${now.model}; finish or archive this task before changing the lead`);
  return now.model===identity.model?null:{model:now.model,note:'same-family model change'};
 }
 // 훅으로 리드를 정한 비 Claude 작업은 매 라운드 관측이 있어야 한다. 운영자 환경변수나 설정으로 정했으면 관측할 수단이 없으므로 등급(C)으로 이미 권한을 줄였다.
 if(identity.enforced&&identity.source==='host-hook')throw Error('LEAD_MODEL_UNOBSERVED: no recent host hook reported the lead model; check the host hook settings');
 return null;
}
