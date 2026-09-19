'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSystemMemory, sizeOf } = require('../lib/memory-report');

const MB = 1048576;

test('summarizes total, free, swap and the biggest apps, and finds this app in the ranking', () => {
  const info = {
    total: 2000 * MB, free: 280 * MB, swap: 459 * MB,
    types: { homey: 476 * MB, 'homey:app:com.big.app': 300 * MB, 'homey:app:com.gpm.sentinels': 96 * MB, 'homey:app:com.small': 10 * MB, zigbeed: 40 * MB }
  };
  const line = summarizeSystemMemory(info, 'com.gpm.sentinels', { top: 3 });
  assert.match(line, /total 2000, free 280 \(14%\), swap 459/);
  assert.match(line, /top: homey 476, com\.big\.app 300, com\.gpm\.sentinels 96/);
  assert.match(line, /this app #3 of 5 at 96 MB/);
  assert.equal(line.includes('raw:'), false);
});

test('reads sizes from objects (pss/rss) and includes the raw response on request', () => {
  const info = { total: 1000 * MB, free: 100 * MB, swap: 0, types: { 'homey:app:a': { rss: 50 * MB, pss: 40 * MB }, 'homey:app:b': { size: 70 * MB } } };
  const line = summarizeSystemMemory(info, 'a', { includeRaw: true });
  assert.match(line, /top: b 70, a 40/);
  assert.match(line, /raw: \{/);
});

test('tolerates missing or odd data without throwing', () => {
  assert.equal(summarizeSystemMemory(undefined, 'x'), 'system memory: no data');
  assert.match(summarizeSystemMemory({ types: { 'homey:app:z': 'weird' } }, 'x'), /total \?, free \? \(\?\)/);
  assert.equal(sizeOf(null), null);
  assert.equal(sizeOf({ mem: { pss: 5 } }), 5);
});
