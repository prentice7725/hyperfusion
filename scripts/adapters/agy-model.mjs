// Model family and reasoning effort are independent configuration dimensions.
// 여기의 model_family는 강도 접미사를 뗀 모델 기본 이름(예: gemini-4-argon)이다. 사용량 기록에 저장되는 필드라 이름을 유지한다.
// 리뷰 독립성을 정하는 계열(만든 회사)은 model-registry의 family이며, 이 값과 다르다.
// Gemini CLI slugs encode effort; custom/Claude models retain the --effort path.
const GEMINI=/^gemini-\d+(?:\.\d+)*-[a-z0-9][a-z0-9-]*$/;
const SUFFIX=/-(low|medium|high)$/;
export const GEMINI_EFFORTS=['low','medium','high'];
export const supportedAgyEfforts=model=>/^claude-(?:opus|sonnet)-/.test(model??'')?[...GEMINI_EFFORTS,'max']:GEMINI_EFFORTS;
export function modelEffort(model) {
 return typeof model==='string'&&GEMINI.test(model)?SUFFIX.exec(model)?.[1]??null:null;
}
// agy에서 강도는 모델 ID에 붙은 값이 정본이고, 모델을 정하지 않은 실행에 --effort를 줘도 효과가 확인되지 않는다(무시된다고 본다).
// 그래서 모델이 없으면 강도를 보내지도, 적용된 것처럼 기록하지도 않는다. 운영자가 모델 없이 강도만 적은 설정은 config가 막는다.
// 난이도별 자동 강도(DIFFICULTY_EFFORT)는 모델이 없는 실행에서 여기서 조용히 빠진다(CLI 기본값으로 돈다).
export function selectAgyModel({model,reasoning_effort:effort}={}) {
 if(model==null)return {model:null,model_family:null,reasoning_effort:null,effort_flag:null};
 const pin=modelEffort(model),effective=pin??effort??null;
 if(effort!=null&&!supportedAgyEfforts(model).includes(effort))throw Error('EFFORT_UNSUPPORTED: AGY model '+(model??'(CLI default)')+' accepts '+supportedAgyEfforts(model).join(', '));
 if(pin&&effort!=null&&pin!==effort)throw Error(`EFFORT_CONFLICT: AGY model ${model} pins ${pin} but reasoning_effort is ${effort}`);
 const family=pin?model.slice(0,-pin.length-1):model??null;
 const gemini=typeof model==='string'&&GEMINI.test(model);
 const resolved=gemini&&!pin&&effective?`${model}-${effective}`:model??null;
 return {model:resolved,model_family:family,reasoning_effort:effective,effort_flag:gemini?null:effort??null};
}
