import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {artifactStatus,validateRecallArtifacts,checkProvenance} from '../scripts/memory-provenance.mjs';
import {retrievalPacket} from '../scripts/memory-packet.mjs';

test('changed and missing artifacts invalidate hits while conflict evidence survives the packet',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hf-artifact-memory-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sha256=crypto.createHash('sha256').update('source v1').digest('hex');
 const provenance={artifact:{path:'design.md',sha256}};
 fs.writeFileSync(path.join(root,'design.md'),'source v1');
 assert.equal(artifactStatus(root,provenance),'artifact_matches');
 const item={id:'f1',type:'procedure',content:'Apply the source-specific workaround',provenance};
 const result={hits:[item,{...item,id:'legacy',provenance:undefined}],needs_review:[{...item,id:'f2',conflicts_with:['f1']}]};
 const original=structuredClone(result);
 assert.equal(validateRecallArtifacts(root,result).hits.length,2);
 fs.writeFileSync(path.join(root,'design.md'),'source v2');
 const checked=validateRecallArtifacts(root,result);
 assert.deepEqual(checked.hits.map(h=>h.id),['legacy']);
 assert.equal(checked.hits[0].artifact_status,'artifact_unknown');
 assert.equal(checked.invalidated[0].artifact_status,'artifact_changed');
 assert.deepEqual(checked.needs_review[0].conflicts_with,['f1']);
 const packet=retrievalPacket(checked,{byte_budget:1024});
 assert.equal(packet.invalidated[0].source_pointer.fragment,'f1');
 assert.deepEqual(result,original);
 fs.unlinkSync(path.join(root,'design.md'));
 assert.equal(artifactStatus(root,provenance),'artifact_missing');
 assert.equal(artifactStatus(root,{artifact:{path:'.',sha256}}),'invalid_provenance');
});

test('unsafe pointers, directories, oversized files and links never qualify as matching artifacts',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hf-artifact-pointer-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sha256='a'.repeat(64),p=path=>({artifact:{path,sha256}});
 for(const unsafe of ['../outside','.. /outside','folder./outside','.git/config','C:/outside','folder\\outside','file:stream','file\0name'])assert.ok(checkProvenance(p(unsafe)).length,unsafe);
 fs.mkdirSync(path.join(root,'directory'));
 assert.equal(artifactStatus(root,p('directory')),'artifact_not_file');
 const fd=fs.openSync(path.join(root,'large'),'w');fs.ftruncateSync(fd,8*1024*1024+1);fs.closeSync(fd);
 assert.equal(artifactStatus(root,p('large')),'artifact_too_large');
 // Directory junctions are available on Windows without symlink privileges.
 fs.symlinkSync(path.join(root,'directory'),path.join(root,'link'),process.platform==='win32'?'junction':'dir');
 assert.equal(artifactStatus(root,p('link')),'artifact_link_refused');
});
