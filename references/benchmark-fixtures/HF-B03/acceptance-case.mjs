import assert from 'node:assert/strict';import fs from 'node:fs';import * as m from './task.mjs';
const xs=['b','a','b','c'];assert.deepEqual(m.unique(xs),['b','a','c']);assert.deepEqual(xs,['b','a','b','c']);
