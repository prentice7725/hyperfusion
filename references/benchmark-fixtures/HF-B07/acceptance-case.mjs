import assert from 'node:assert/strict';import fs from 'node:fs';import * as m from './task.mjs';
fs.writeFileSync('.build/value.txt','old');assert.throws(()=>m.save('.build/value.txt','new',true));assert.equal(fs.readFileSync('.build/value.txt','utf8'),'old');m.save('.build/value.txt','new');assert.equal(fs.readFileSync('.build/value.txt','utf8'),'new');
