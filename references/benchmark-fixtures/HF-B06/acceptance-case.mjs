import assert from 'node:assert/strict';import fs from 'node:fs';import * as m from './task.mjs';
assert.equal(m.normalize('src\\service.js'),'src/service.js');assert.equal(m.normalize('src/service.js'),'src/service.js');assert.equal(m.normalize('./src/service.js'),'src/service.js');
