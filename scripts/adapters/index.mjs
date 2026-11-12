import * as grok from './grok.mjs';
import * as antigravity from './antigravity.mjs';
import {sonnet,haiku,opus} from './claude.mjs';
import {sol,luna,terra} from './codex.mjs';
export const ADAPTERS={grok,antigravity,sonnet,haiku,sol,luna,terra,opus};
export function adapter(name) {
 const a=ADAPTERS[name];
 if(!a)throw Error('Unknown executor '+name);
 return a;
}
