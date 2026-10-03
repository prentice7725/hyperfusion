import fs from 'node:fs';
import path from 'node:path';
import {read} from './artifact.mjs';
export const DEFAULT_CONFIG={lead:'sol',lead_model:'gpt-6.1-sol',lead_reasoning_effort:'high',internal_helper:{provider:'luna'},external:{default:'claude',available:['claude','grok','antigravity']}};
export const REGISTRY={claude:{implemented:true,milestone:'M0'},grok:{implemented:false,milestone:'M1'},antigravity:{implemented:false,milestone:'M2'},auto:{implemented:false,milestone:'after M2'}};
export function config(root) {
 const file=path.join(root,'hyperfusion.config.json');
 const v=fs.existsSync(file)?read(file):structuredClone(DEFAULT_CONFIG);
 // Normalize the old role label without changing executor settings.
 if(v.lead==='astra')v.lead='sol';
 v.lead_model??='gpt-6.1-sol';v.lead_reasoning_effort??='high';
 if(v.lead!=='sol'||v.lead_model!=='gpt-6.1-sol'||v.lead_reasoning_effort!=='high'||v.internal_helper?.provider!=='luna'||!v.external||!Array.isArray(v.external.available)||!v.external.available.length||v.external.available.some(x=>!['claude','grok','antigravity'].includes(x))||!v.external.available.includes(v.external.default))throw Error('Invalid HyperFusion configuration');
 return v;
}
export function selectExecutor(c,requested) {
 const name=requested??c.external.default;
 if(name==='auto')throw Error('ADAPTER_UNAVAILABLE: auto-routing is planned after M2');
 if(!['claude','grok','antigravity'].includes(name))throw Error('Executor must be claude, grok, antigravity, or auto');
 if(!c.external.available.includes(name))throw Error('Executor not enabled in configuration: '+name);
 if(!REGISTRY[name].implemented)throw Error('ADAPTER_UNAVAILABLE: '+name+' is planned for '+REGISTRY[name].milestone);
 return name;
}
