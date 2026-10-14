import assert from 'node:assert/strict';import fs from 'node:fs';import * as m from './task.mjs';
assert.deepEqual(m.page([],0,2),[]);assert.deepEqual(m.page([1,2,3,4,5],0,2),[1,2]);assert.deepEqual(m.page([1,2,3,4,5],2,2),[5]);assert.deepEqual(m.page([1],3,2),[]);
