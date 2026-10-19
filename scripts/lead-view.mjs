// 리드(Opus)가 명령줄에서 받는 출력의 기본 보기. 모델 호출도, 상태 변경도 하지 않는다.
// 리드는 다음 수를 두는 데 필요한 것만 읽으면 된다. 일꾼에게 갈 전체 지시문, 프로브 결과, 설정 전체는
// 파일(dispatch-N.json, state.json)에 그대로 있으므로 출력에서 빼도 정보가 사라지지 않는다. 전체가 필요하면 --full.
// run()의 반환값은 바꾸지 않는다(오토파일럿과 테스트는 전체를 쓴다). 이 보기는 명령줄 출력에만 적용한다.
import {nextAction} from './state-policy.mjs';

// 상태를 통째로 돌려주는 액션과, 일꾼 실행 설명서를 돌려주는 액션. 그 밖(status, report, consult 등)은 그대로 둔다.
export const COMPACT_ACTIONS=new Set(['init','begin','finish','review','decide','verify','recover','grant-implement','lead-decision','consult-finish','policy-approve']);

// 상태에서 리드가 읽지 않는 큰 덩어리. 값은 state.json에 남아 있다.
const STATE_BULK=['configuration','sessions','consults','review_results','routing','assignment','implementation_selection','limits'];

const small=(value,limit=400)=>{try{return JSON.stringify(value)?.length<=limit;}catch{return false;}};

export function compactView(action,out) {
 if(!out||typeof out!=='object'||Array.isArray(out))return out;
 if(!COMPACT_ACTIONS.has(action))return out;
 const view={};
 const dropped=[];
 // 일꾼 실행 설명서: 리드에게 필요한 것은 실행할 명령, 인자, 토큰이다. cli와 prompt는 dispatch-N.json에 있다.
 const descriptor=typeof out.command==='string'&&Array.isArray(out.args);
 for(const [key,value] of Object.entries(out)){
  if(action==='consult-finish'&&key==='results'&&Array.isArray(value)){
   view.results=value.map(r=>({member:r.member,reviewer:r.executor,verdict:r.recommended_verdict,findings:r.findings?.length??0}));dropped.push('results.*');continue;
  }
  if(descriptor&&(key==='cli'||key==='prompt')){dropped.push(key);continue;}
  if(out.phase&&out.schema_version!==undefined&&STATE_BULK.includes(key)){dropped.push(key);continue;}
  if(key==='lead_decision'&&value&&typeof value==='object'){
   view[key]=pick(value,['authority','decision','requested_decision','round','owner','required_reviewer','next_executor','file','lead_filled_seats','overruled_reviews','keep_owner_reason']);
   dropped.push('lead_decision.*');continue;
  }
  view[key]=value;
 }
 // 상태형 출력에는 다음 동작과 짧은 라우팅 요약을 붙인다(리드가 status를 따로 부르지 않게).
 if(out.phase&&out.schema_version!==undefined){
  view.next_action=nextAction(out.phase,!!out.open_consult);
  if(out.routing)view.routing={executor:out.routing.executor??null,mode:out.routing.mode??null,difficulty:out.routing.difficulty??null};
  if(Array.isArray(out.review_results?.[out.iteration])){
   view.review_results=out.review_results[out.iteration].map(r=>({executor:r.executor,verdict:r.verdict,ok:r.ok,...(r.superseded?{superseded:true}:{})}));
  }
 }
 if(dropped.length)view.omitted=`${dropped.join(', ')} (original task artifacts retain these fields; add --full to print everything)`;
 return view;
}

function pick(object,keys) {
 return Object.fromEntries(keys.filter(k=>object[k]!==undefined&&small(object[k],600)).map(k=>[k,object[k]]));
}
