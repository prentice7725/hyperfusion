import * as grok from './grok.mjs';
import * as antigravity from './antigravity.mjs';
import {sonnet,haiku} from './claude.mjs';
import {sol,luna} from './codex.mjs';
export const ADAPTERS={grok,antigravity,sonnet,haiku,sol,luna};
export function adapter(name) {
 const a=ADAPTERS[name];
 if(!a)throw Error('Unknown executor '+name);
 return a;
}
