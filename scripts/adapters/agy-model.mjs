// Model family and reasoning effort are independent configuration dimensions.
// Gemini CLI slugs encode effort; custom/Claude models retain the --effort path.
const GEMINI=/^gemini-\d+(?:\.\d+)*-[a-z0-9][a-z0-9-]*$/;
const SUFFIX=/-(low|medium|high)$/;
export const GEMINI_EFFORTS=['low','medium','high'];
export const supportedAgyEfforts=model=>/^claude-(?:opus|sonnet)-/.test(model??'')?[...GEMINI_EFFORTS,'max']:GEMINI_EFFORTS;
export function modelEffort(model) {
 return typeof model==='string'&&GEMINI.test(model)?SUFFIX.exec(model)?.[1]??null:null;
}
export function selectAgyModel({model,reasoning_effort:effort}={}) {
 const pin=modelEffort(model),effective=pin??effort??null;
 if(effort!=null&&!supportedAgyEfforts(model).includes(effort))throw Error('EFFORT_UNSUPPORTED: AGY model '+(model??'(CLI default)')+' accepts '+supportedAgyEfforts(model).join(', '));
 if(pin&&effort!=null&&pin!==effort)throw Error(`EFFORT_CONFLICT: AGY model ${model} pins ${pin} but reasoning_effort is ${effort}`);
 const family=pin?model.slice(0,-pin.length-1):model??null;
 const gemini=typeof model==='string'&&GEMINI.test(model);
 const resolved=gemini&&!pin&&effective?`${model}-${effective}`:model??null;
 return {model:resolved,model_family:family,reasoning_effort:effective,effort_flag:gemini?null:effort??null};
}
