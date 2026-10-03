import fs from 'node:fs';
import path from 'node:path';
import {read} from './artifact.mjs';

// 리드는 Claude Opus 5.5 하나로 고정. 일꾼은 Grok과 Antigravity.
export const EXECUTORS=['grok','antigravity'];
export const CAP={grok:3,antigravity:3,lead:1};
export const DEFAULT_CONFIG={lead:'opus',lead_model:'claude-opus-5-5',lead_takeover:true,external:{default:'grok',available:['grok','antigravity']},executors:{antigravity:{sandbox:true}}};

export function config(root) {
 const file=path.join(root,'hyperfusion.config.json');
 const v=fs.existsSync(file)?read(file):structuredClone(DEFAULT_CONFIG);
 if(['sol','astra'].includes(v.lead))throw Error('Invalid HyperFusion configuration: Codex lead config belongs to the main branch; this branch is Opus-led');
 v.lead??='opus';v.lead_model??='claude-opus-5-5';v.lead_takeover??=true;v.executors??={};v.executors.antigravity??={sandbox:true};
 const ok=v.lead==='opus'&&v.lead_model==='claude-opus-5-5'&&typeof v.lead_takeover==='boolean'&&v.external&&Array.isArray(v.external.available)&&v.external.available.length&&v.external.available.every(x=>EXECUTORS.includes(x))&&v.external.available.includes(v.external.default)&&typeof (v.executors.antigravity.sandbox??true)==='boolean';
 if(!ok)throw Error('Invalid HyperFusion configuration');
 return v;
}

export function selectExecutor(c,requested) {
 const name=requested??c.external.default;
 if(name==='auto')throw Error('ADAPTER_UNAVAILABLE: auto-routing is not implemented; the lead picks the worker');
 if(['claude','opus','luna'].includes(name))throw Error('Claude is the lead, not a worker. Executor must be grok or antigravity');
 if(!EXECUTORS.includes(name))throw Error('Executor must be grok or antigravity');
 if(!c.external.available.includes(name))throw Error('Executor not enabled in configuration: '+name);
 return name;
}
