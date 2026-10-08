import * as grok from './grok.mjs';
import * as antigravity from './antigravity.mjs';
import * as sonnet from './sonnet.mjs';
import * as codex from './codex.mjs';
export const ADAPTERS={grok,antigravity,sonnet,codex};
export function adapter(name) {
 const a=ADAPTERS[name];
 if(!a)throw Error('Unknown executor '+name);
 return a;
}
