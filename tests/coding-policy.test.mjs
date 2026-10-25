import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {codingPolicy,CODING_POLICIES} from '../scripts/coding-policy.mjs';
import {prompt} from '../scripts/adapters/common.mjs';

const withConfig=(t,body)=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(body));
 return f;
};

test('the ponytail policy is pinned, licensed and free of rules that conflict with JSON results',()=>{
 const p=codingPolicy('ponytail');
 assert.match(p.source,/ponytail\/blob\/[0-9a-f]{40}\/AGENTS\.md$/);assert.match(p.sha256,/^[0-9a-f]{64}$/);
 assert.match(fs.readFileSync(new URL('../assets/coding-policies/ponytail.LICENSE',import.meta.url),'utf8'),/^MIT License\n\nCopyright \(c\) 2026 DietrichGebert/);
 assert.match(p.text,/Never cut: validation at trust boundaries/);
 assert.doesNotMatch(p.text,/End your reply|shortcut:/,'prose endings and comment markers would break result JSON or add noise');
 assert.throws(()=>codingPolicy('caveman'),/coding_policy must be one of ponytail/);
 assert.deepEqual(Object.keys(CODING_POLICIES),['ponytail']);
});

test('a configured coding policy reaches implementation prompts only, with its hash',t=>{
 const f=withConfig(t,{coding_policy:'ponytail'});
 run(f.root,'init',f.brief);
 const d=f.begin({coding_policy:undefined});
 const body=JSON.parse(d.prompt);
 assert.equal(body.coding_policy.id,'ponytail');assert.equal(body.coding_policy.sha256,codingPolicy('ponytail').sha256);
 assert.equal('coding_policy' in body.brief,false,'the policy id is not repeated inside the brief');
 const at=body.instructions.findIndex(i=>/^Coding policy "ponytail"/.test(i));
 assert.ok(at>0);assert.match(body.instructions[at],/take precedence over it.*in risks; never as prose/);
 assert.equal(body.instructions[at+1],codingPolicy('ponytail').text);
 const consult=JSON.parse(prompt({...body.brief,coding_policy:'ponytail',consult:{id:'c1',mode:'advisor',member:'sol'}},{owner:'sol'}));
 assert.equal(consult.coding_policy,undefined,'reviews and consultations are not coding rounds');
});

test('without the setting prompts are unchanged, and a brief cannot switch the policy on',t=>{
 const f=withConfig(t,{});
 run(f.root,'init',f.brief);
 const body=JSON.parse(f.begin({coding_policy:'ponytail'}).prompt);
 assert.equal(body.coding_policy,undefined);assert.ok(!body.instructions.some(i=>/Coding policy/.test(i)));
});

test('an unknown coding policy is rejected at configuration time',t=>{
 const f=withConfig(t,{coding_policy:'golf'});
 assert.throws(()=>run(f.root,'init',f.brief),/coding_policy must be one of ponytail/);
});
