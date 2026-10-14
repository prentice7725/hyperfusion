import assert from 'node:assert/strict';import fs from 'node:fs';import * as m from './task.mjs';
assert.deepEqual(m.parse('\ufeff{"ok":true}'),{ok:true});assert.throws(()=>m.parse('{'),/JSON|Unexpected|property/i);
