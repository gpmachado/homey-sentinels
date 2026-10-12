'use strict';
// When a monitor is used: cycles by weekday and local hour, worked out from the cycles it already keeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { usagePattern, describeUsagePattern, weekdayName, hourLabel } = require('../lib/usage-pattern');
const { wordingFor } = require('../lib/wording');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// Sunday 2026-10-04 12:00 UTC. 2026-09-28 was a Monday.
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const at = (day, hour, minute = 0) => Date.UTC(2026, 8, 28 + day, hour, minute); // day 0 = Monday 28 Sept
const cycle = (startedAt, minutes) => ({ startedAt, endedAt: startedAt + minutes * 60000, duration: minutes * 60 });
const monitor = (cycles) => ({ cycles });
const UTC = { timeZone: 'UTC', now: NOW };

test('cycles are counted by weekday (0 = Monday) and local hour, and the time on is spread over the hours it covers', () => {
  const p = usagePattern(monitor([cycle(at(0, 8, 30), 105), cycle(at(0, 8, 0), 30)]), { ...UTC, period: 'all' });
  assert.equal(p.starts[0][8], 2); // both started on Monday in hour 8
  assert.equal(p.cycleCount, 2);
  // 08:30-10:15 covers 8 (30 min), 9 (60), 10 (15); the second adds 30 min to hour 8
  assert.deepEqual([p.seconds[0][8], p.seconds[0][9], p.seconds[0][10]], [3600, 3600, 900]);
  assert.equal(p.weekdayStarts[0], 2);
  assert.equal(p.hourStarts[8], 2);
});

test('fewer than 5 cycles is not a pattern: nothing is named', () => {
  const p = usagePattern(monitor([cycle(at(0, 8), 60), cycle(at(1, 8), 60), cycle(at(2, 8), 60), cycle(at(3, 8), 60)]), UTC);
  assert.equal(p.enough, false);
  assert.equal(p.busiestWeekday, null);
  assert.equal(p.busiestHour, null);
  assert.equal(p.dayShare, null);
  assert.equal(p.cycleCount, 4);
});

test('the busiest weekday and hour, the share of cycles on it and the share of the time on in the day', () => {
  // Saturday (5) three times at 18:00, Monday once at 08:00 and once at 23:00 (night)
  const cycles = [cycle(at(5, 18), 60), cycle(at(5, 18, 10), 60), cycle(at(5, 18, 20), 60), cycle(at(0, 8), 60), cycle(at(0, 23), 60)];
  const p = usagePattern(monitor(cycles), { timeZone: 'UTC', now: NOW, period: 'all' });
  assert.equal(p.enough, true);
  assert.equal(p.busiestWeekday, 5);
  assert.equal(p.busiestWeekdayShare, 60);
  assert.equal(p.busiestHour, 18);
  // time on: 4 h of 5 h is between 06:00 and 22:00
  assert.equal(p.dayShare, 80);
  assert.equal(p.nightShare, 20);
});

test('a weekday is compared by cycles per day, not by raw count', () => {
  // 30 days back from Sun 4 Oct there are five Sundays and four Mondays. Four cycles on each: the counts tie, but
  // Monday is 4 in 4 days (1.0 a day) and Sunday 4 in 5 (0.8 a day), so Monday is the busier weekday.
  const monday = [0, 1, 2, 3].map((w) => cycle(Date.UTC(2026, 8, 7 + 7 * w, 8), 60)); // Mondays 7, 14, 21, 28 Sept
  const sunday = [0, 1, 2, 3].map((w) => cycle(Date.UTC(2026, 8, 13 + 7 * w, 9), 60)); // Sundays 13, 20, 27 Sept, 4 Oct
  const p = usagePattern(monitor([...sunday, ...monday]), { timeZone: 'UTC', now: NOW, period: 'month' });
  assert.equal(p.weekdayStarts[0], 4);
  assert.equal(p.weekdayStarts[6], 4);
  assert.equal(p.busiestWeekday, 0);
});

test('the period keeps only the cycles that started inside it', () => {
  const old = [cycle(at(0, 8) - 20 * DAY, 60), cycle(at(0, 8) - 21 * DAY, 60)];
  const recent = [0, 1, 2, 3, 4].map((d) => cycle(at(d, 20), 60));
  const all = [...old, ...recent];
  assert.equal(usagePattern(monitor(all), { ...UTC, period: 'week' }).cycleCount, 5);
  assert.equal(usagePattern(monitor(all), { ...UTC, period: 'month' }).cycleCount, 7);
  assert.equal(usagePattern(monitor(all), { ...UTC, period: 'week' }).busiestHour, 20);
});

test('hours are local: the same instant lands in a different hour in another time zone', () => {
  const five = [0, 1, 2, 3, 4].map((d) => cycle(at(d, 23), 30)); // 23:00 UTC = 20:00 in Sao Paulo (UTC-3, no DST in 2026)
  assert.equal(usagePattern(monitor(five), { timeZone: 'UTC', now: NOW, period: 'all' }).busiestHour, 23);
  assert.equal(usagePattern(monitor(five), { timeZone: 'America/Sao_Paulo', now: NOW, period: 'all' }).busiestHour, 20);
  // 02:00 UTC on a Tuesday is still Monday evening in Sao Paulo
  const late = [0, 1, 2, 3, 4].map((d) => cycle(at(d + 1, 2), 30));
  assert.equal(usagePattern(monitor(late), { timeZone: 'America/Sao_Paulo', now: NOW, period: 'all' }).busiestWeekday, 0);
  assert.equal(usagePattern(monitor(late), { timeZone: 'UTC', now: NOW, period: 'all' }).busiestWeekday, 1);
});

test('a cycle across a daylight saving change still adds up to its real duration', () => {
  // Europe/Oslo, clocks back on 2026-10-25: a 5 h cycle from 00:00 UTC spans the 25 h day
  const p = usagePattern(monitor([cycle(Date.UTC(2026, 9, 24, 22), 300)]), { timeZone: 'Europe/Oslo', now: Date.UTC(2026, 9, 26), period: 'all' });
  assert.equal(p.weekdaySeconds.reduce((a, b) => a + b, 0), 300 * 60);
});

test('damaged rows are ignored and a cycle that never ended cannot loop for ever', () => {
  const odd = [{ startedAt: 'x', endedAt: 1 }, { startedAt: at(0, 8), endedAt: at(0, 7) }, { startedAt: NOW - HOUR, endedAt: NOW - HOUR + 400 * DAY }];
  const p = usagePattern(monitor(odd), UTC);
  assert.equal(p.cycleCount, 1);
  assert.ok(p.weekdaySeconds.reduce((a, b) => a + b, 0) <= 14 * 24 * 3600); // capped at two weeks
  assert.deepEqual(usagePattern({}, UTC).starts.map((row) => row.reduce((a, b) => a + b, 0)), [0, 0, 0, 0, 0, 0, 0]);
});

test('weekday names follow the language, hours are written as a range', () => {
  assert.equal(weekdayName(5, 'en'), 'Saturday');
  assert.equal(weekdayName(5, 'pt'), 'sábado');
  assert.equal(weekdayName(0, 'pt'), 'segunda-feira');
  assert.equal(weekdayName(6, 'no'), 'søndag');
  assert.equal(weekdayName(2, 'zz-invalid'), 'Wednesday'); // an unknown locale falls back to English
  assert.equal(hourLabel(18), '18:00-19:00');
  assert.equal(hourLabel(23), '23:00-00:00');
});

test('the sentence comes out in the chosen language, and says how many cycles are still missing', () => {
  const cycles = [cycle(at(5, 18), 60), cycle(at(5, 18, 10), 60), cycle(at(5, 18, 20), 60), cycle(at(0, 8), 60), cycle(at(0, 23), 60)];
  const pattern = usagePattern(monitor(cycles), { timeZone: 'UTC', now: NOW, period: 'all' });
  const pt = describeUsagePattern(pattern, { name: 'Bomba', language: 'pt', wording: wordingFor('pt').usagePatternMessages });
  assert.equal(pt.message, 'Dia de maior uso de Bomba: sábado (60% do uso), horário de pico 18:00-19:00; 80% do tempo ligado é entre 06:00 e 22:00.');
  assert.equal(pt.weekdayName, 'sábado');
  const en = describeUsagePattern(pattern, { name: 'Pump', language: 'en', wording: wordingFor('en').usagePatternMessages });
  assert.match(en.message, /^Most use of Pump: Saturday \(60% of the use\), busiest around 18:00-19:00; 80% of the time on/);
  const few = describeUsagePattern(usagePattern(monitor(cycles.slice(0, 2)), UTC), { name: 'Bomba', language: 'pt', wording: wordingFor('pt').usagePatternMessages });
  assert.equal(few.message, 'Bomba: ainda não há ciclos suficientes para ver um padrão (2 de 5).');
  assert.equal(few.weekdayName, '');
});

const withPower = (startedAt, minutes, energy, averagePower) => ({ ...cycle(startedAt, minutes), energy, averagePower });

test('energy is shared out by the time a cycle spends in each hour, and power is the time-weighted average while on', () => {
  const p = usagePattern(monitor([withPower(at(0, 8, 30), 105, 1.05, 600), withPower(at(0, 8, 0), 30, 0.1, 200)]), { ...UTC, period: 'all' });
  // 08:30-10:15 at 1.05 kWh: 30/60/15 of 105 minutes; the second cycle adds 0.1 kWh in hour 8
  assert.deepEqual([p.energy[0][8], p.energy[0][9], p.energy[0][10]], [0.4, 0.6, 0.15]);
  assert.equal(p.totalEnergy, 1.15);
  // hour 8: 30 min at 600 W and 30 min at 200 W -> 400 W; hours 9 and 10: 600 W
  assert.deepEqual([p.power[0][8], p.power[0][9], p.power[0][10]], [400, 600, 600]);
  assert.equal(p.power[0][7], 0); // no cycle there
});

test('the hour with the highest average power is named only with enough cycles', () => {
  const few = usagePattern(monitor([withPower(at(0, 8), 60, 1, 1000)]), UTC);
  assert.equal(few.peakPowerHour, null);
  assert.equal(few.peakPower, null);
  const cycles = [0, 1, 2, 3].map((d) => withPower(at(d, 8), 60, 0.3, 300)).concat([withPower(at(4, 19), 60, 2, 2000)]);
  const p = usagePattern(monitor(cycles), UTC);
  assert.equal(p.peakPowerHour, 19);
  assert.equal(p.peakPower, 2000);
  assert.equal(describeUsagePattern(p, { name: 'X', language: 'en', wording: wordingFor('en').usagePatternMessages }).peakPowerHourLabel, '19:00-20:00');
});

test('a device without an energy reading still gets power, and energy stays zero without breaking anything', () => {
  const cycles = [0, 1, 2, 3, 4].map((d) => ({ ...cycle(at(d, 8), 60), energy: 0, averagePower: 150 }));
  const p = usagePattern(monitor(cycles), UTC);
  assert.equal(p.totalEnergy, 0);
  assert.equal(p.power[0][8], 150);
  const none = usagePattern(monitor([0, 1, 2, 3, 4].map((d) => cycle(at(d, 8), 60))), UTC); // neither energy nor power on the cycle
  assert.equal(none.peakPowerHour, null);
  assert.equal(none.totalEnergy, 0);
});

test('hourShare is the percent of cycles that started in the current local hour, and null while there are too few to judge', () => {
  const { hourShare } = require('../lib/usage-pattern');
  const evenings = Array.from({ length: 19 }, (_, d) => cycle(at(d % 7, 19, 10), 30));
  assert.equal(hourShare(monitor(evenings), { timeZone: 'UTC', time: at(0, 19, 40) }), null); // 19 cycles: not enough yet
  const all = [...evenings, cycle(at(2, 3, 5), 20)]; // one at 03:xx
  assert.equal(hourShare(monitor(all), { timeZone: 'UTC', time: at(0, 19, 40) }), 95);
  assert.equal(hourShare(monitor(all), { timeZone: 'UTC', time: at(1, 3, 59) }), 5);
  assert.equal(hourShare(monitor(all), { timeZone: 'UTC', time: at(1, 12, 0) }), 0);
  assert.equal(hourShare(monitor(all), { timeZone: 'America/Sao_Paulo', time: at(0, 19, 40) }), 95); // 19:xx UTC is 16:xx in Sao Paulo, for the cycles and for now alike
  assert.equal(hourShare(monitor(all), { timeZone: 'America/Sao_Paulo', time: at(0, 22, 40) }), 0); // 22:40 UTC is 19:40 there, an hour with no cycles
});
