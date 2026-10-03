import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {read,immutable} from './artifact.mjs';
export function acquire(root,task_id,round,owner) {
 const lease={task_id,round,owner,token:crypto.randomUUID(),created_at:new Date().toISOString()};
 immutable(path.join(root,'.fusion/locks/writer.json'),lease);
 return lease;
}
export function assertLease(root,token) {
 const v=read(path.join(root,'.fusion/locks/writer.json'));
 if(v.token!==token) throw Error('Writer token mismatch');
 return v;
}
export function release(root,token) {
 assertLease(root,token); fs.unlinkSync(path.join(root,'.fusion/locks/writer.json'));
}
// No TTL stealing. The holder is a model session, not this short-lived CLI PID.
