'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startOfLocalDay, isValidTimeZone } = require('../lib/time');

test('finds local midnight for a timezone behind UTC (São Paulo, UTC-3)', () => {
  const now = new Date('2026-08-29T14:35:00Z');
  const midnight = startOfLocalDay(now, 'America/Sao_Paulo');
  assert.equal(midnight.toISOString(), '2026-08-29T03:00:00.000Z');
});

test('finds local midnight for a timezone ahead of UTC (Tokyo, UTC+9)', () => {
  const now = new Date('2026-08-29T01:00:00Z'); // 10:00 local in Tokyo, still the 29th there
  const midnight = startOfLocalDay(now, 'Asia/Tokyo');
  assert.equal(midnight.toISOString(), '2026-08-28T15:00:00.000Z');
});

test('a sample taken just after local midnight still belongs to the new day', () => {
  const now = new Date('2026-08-29T03:00:01Z'); // 00:00:01 in São Paulo
  const midnight = startOfLocalDay(now, 'America/Sao_Paulo');
  assert.equal(midnight.getTime(), new Date('2026-08-29T03:00:00.000Z').getTime());
  assert.ok(midnight.getTime() <= now.getTime());
});

test('isValidTimeZone accepts a real IANA zone and rejects garbage', () => {
  assert.equal(isValidTimeZone('America/Sao_Paulo'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Not/A_Zone'), false);
  assert.equal(isValidTimeZone(''), false);
});
