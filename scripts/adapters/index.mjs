import * as grok from './grok.mjs';
import * as antigravity from './antigravity.mjs';
export const ADAPTERS={grok,antigravity};
export function adapter(name) {
 const a=ADAPTERS[name];
 if(!a)throw Error('Unknown executor '+name);
 return a;
}
