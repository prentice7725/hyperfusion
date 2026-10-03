export const capabilities={mode:'lead-mediated',model:'gpt-5.6-luna',persistent:true,automatic_transport:false};
export function dispatch(brief,lease,session=null) {
 const message=JSON.stringify({protocol:'hyperfusion-external-v0.2',brief,
 result_template:{task_id:brief.task_id,round:brief.round,status:'complete',summary:'Describe actual outcome',files_read:[],files_changed:[],commands_run:[],tests:[],unresolved:[],risks:[],needs_lead_decision:false,recommended_next_action:'review'},
 result_rules:[
  'Return the filled result_template as JSON. Keep task_id and round unchanged.',
  'status must be complete, blocked, needs_decision, or failed. needs_decision requires needs_lead_decision=true.',
  'files_read and files_changed are repository-relative string arrays; files_changed covers only this round.',
  'commands_run, unresolved and risks are string arrays. tests contains actual {command, status} objects with status pass, fail, or not_run.',
  'Use empty arrays when nothing was run or changed. Never invent evidence. complete requires no failed tests, unresolved items or pending lead decision.'
 ],writer:{token:lease.token,owner:lease.owner},instructions:[
 'Execute only this brief. Do not delegate, commit, stage, push, deploy or expand scope.',
 'Do not edit .fusion. Lead owns protocol metadata. Return structured result only.',
 'Stop all commands and child processes before returning. A result ends your write authority.',
 'Request lead decision when scope or architecture is insufficient.'
 ]});
 return session ? {tool:'collaboration.followup_task',arguments:{target:session,message}} :
 {tool:'collaboration.spawn_agent',arguments:{task_name:'hf_luna_'+brief.task_id.toLowerCase().replaceAll('-','_'),fork_turns:'none',model:capabilities.model,message}};
}
