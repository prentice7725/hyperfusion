import assert from 'node:assert/strict';import fs from 'node:fs';import * as m from './task.mjs';
const doc=fs.readFileSync('QUICKSTART.md','utf8');for(const flag of m.flags)assert.ok(doc.includes(flag),'missing '+flag);for(const flag of doc.match(/--[a-z-]+/g)||[])assert.ok(m.flags.includes(flag),'unknown '+flag);
