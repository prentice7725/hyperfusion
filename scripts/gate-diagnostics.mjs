// Observation only. The controller supplies the existing conditions and prose.
export function gateCollector(state) {
 const unmet=[],passed=[],checks=[];
 const need=(ok,code,name,why)=>{
  (ok?passed:unmet).push(ok?name:why);
  checks.push({code,passed:!!ok,detail:ok?name:why,required_evidence:name});
  return ok;
 };
 const result=()=>({eligible:unmet.length===0,unmet,passed,
  task_id:state.task_id,round:state.iteration,digest:state.post_digest??null,
  policy:state.delegation?.policy??null,policy_revision:state.delegation?.revision??null,
  diagnostic_revision:1,reason_codes:checks.filter(c=>!c.passed).map(c=>c.code),
  lead_required:unmet.length>0,checks});
 return {need,result};
}
