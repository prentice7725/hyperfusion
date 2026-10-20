// A conservative UTF-8 byte bound, not a model-specific token estimate.
// Full evidence stays in the workspace store; omitted text is never summarized.
export function retrievalPacket(result,{byte_budget=12000}={}) {
 if(!Number.isInteger(byte_budget)||byte_budget<512||byte_budget>65536)throw Error('memory byte_budget must be an integer from 512 to 65536');
 const packet={revision:1,authority:'advisory',hits:[],needs_review:[],omitted:[],truncated:false};
 if(result.invalidated)packet.invalidated=result.invalidated;
 const size=()=>Buffer.byteLength(JSON.stringify(packet),'utf8');
 // Compact pointers cover every returned item, including unresolved contradictions,
 // before spending any budget on content. Refuse budgets that cannot preserve them.
 for(const [kind,items] of [['hit',result.hits],['needs_review',result.needs_review]]){
  for(const item of items)packet.omitted.push({kind,id:item.id,source_pointer:{fragment:item.id},conflicts_with:item.conflicts_with??[]});
 }
 if(size()>byte_budget)throw Error('MEMORY_PACKET_BUDGET: increase byte_budget or narrow the query to preserve all evidence pointers');
 for(let i=0;i<packet.omitted.length;){
  const pointer=packet.omitted[i];
  const item=(pointer.kind==='hit'?result.hits:result.needs_review).find(x=>x.id===pointer.id);
  const destination=pointer.kind==='hit'?packet.hits:packet.needs_review;
  destination.push({...item,source_pointer:pointer.source_pointer});packet.omitted.splice(i,1);
  if(size()>byte_budget){destination.pop();packet.omitted.splice(i,0,pointer);i++;}
 }
 packet.truncated=packet.omitted.length>0;
 // `true` is shorter than `false`, so the final flag cannot overflow the bound.
 return packet;
}
