'use strict';

// When a monitor is used: cycles started, time on, energy and average power, by weekday and hour of the local day.
// Worked out from the cycles the monitor already keeps (a year of them), so nothing extra is stored. Works for Activity and State
// monitors alike (a state session is a cycle). Voltage monitors have no cycles and are not covered.
const { renderMessage } = require('./message-template');
const { recentLocalDayStarts } = require('./time');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // index 0 = Monday
const PERIOD_DAYS = { week: 7, month: 30 };  // anything else (all) = every cycle kept
const MIN_CYCLES = 5;                         // fewer than this and a "pattern" is chance
const DAY_FIRST_HOUR = 6;                     // "day" is 06:00 to 21:59, "night" the rest
const NIGHT_FIRST_HOUR = 22;
const MAX_CYCLE_DAYS = 14;                    // a cycle longer than this is a stuck reading, not a use
const MAX_DAYS_COUNTED = 366;
const UNUSUAL_MIN_CYCLES = 20;               // fewer than this and "usual hours" are not known yet

// The weekday (0 = Monday), hour and seconds into that hour of an instant, in a time zone.
function localSlotter(timeZone) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (time) => {
    const parts = {};
    for (const part of format.formatToParts(new Date(time))) parts[part.type] = part.value;
    return { weekday: WEEKDAYS.indexOf(parts.weekday), hour: Number(parts.hour) % 24, secondsIntoHour: Number(parts.minute) * 60 + Number(parts.second) };
  };
}

const grid = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
const sum = (values) => values.reduce((total, value) => total + value, 0);

// Index of the largest value, ties broken by `tiebreak`; -1 when everything is zero.
function peak(values, tiebreak) {
  let best = -1;
  values.forEach((value, index) => {
    if (value <= 0) return;
    if (best < 0 || value > values[best] || (value === values[best] && tiebreak[index] > tiebreak[best])) best = index;
  });
  return best;
}

function usagePattern(monitor, { timeZone, period = 'month', now = Date.now() } = {}) {
  const slotOf = localSlotter(timeZone);
  const days = PERIOD_DAYS[period];
  const since = days ? now - days * DAY_MS : 0;
  const cycles = (monitor.cycles || []).filter((cycle) => Number.isFinite(cycle.startedAt) && Number.isFinite(cycle.endedAt) && cycle.endedAt >= cycle.startedAt && cycle.startedAt >= since && cycle.startedAt <= now);

  const starts = grid();
  const seconds = grid();
  const energy = grid();       // kWh, a cycle's energy shared out by the time it spends in each hour
  const powerWeighted = grid(); // watt-seconds: a cycle's average power times the seconds it spends in the hour
  const powerSeconds = grid();  // the seconds behind powerWeighted (only cycles that have an average power)
  for (const cycle of cycles) {
    const first = slotOf(cycle.startedAt);
    starts[first.weekday][first.hour] += 1;
    // The time on is spread over the local hours it covers (a cycle from 08:30 to 10:15 counts in 8, 9 and 10).
    const end = Math.min(cycle.endedAt, cycle.startedAt + MAX_CYCLE_DAYS * DAY_MS);
    const length = (end - cycle.startedAt) / 1000;
    let time = cycle.startedAt;
    while (time < end) {
      const slot = slotOf(time);
      const next = Math.min(end, time - (((time % 1000) + 1000) % 1000) + (3600 - slot.secondsIntoHour) * 1000);
      if (!(next > time)) break;
      const slice = (next - time) / 1000;
      seconds[slot.weekday][slot.hour] += slice;
      if (Number.isFinite(cycle.energy) && length > 0) energy[slot.weekday][slot.hour] += cycle.energy * (slice / length);
      if (Number.isFinite(cycle.averagePower)) { powerWeighted[slot.weekday][slot.hour] += cycle.averagePower * slice; powerSeconds[slot.weekday][slot.hour] += slice; }
      time = next;
    }
  }

  const weekdayStarts = starts.map(sum);
  const weekdaySeconds = seconds.map(sum);
  const hourStarts = Array.from({ length: 24 }, (_, hour) => sum(starts.map((row) => row[hour])));
  const hourSeconds = Array.from({ length: 24 }, (_, hour) => sum(seconds.map((row) => row[hour])));

  // Each weekday is compared by cycles per day of that weekday, so a weekday that happens five times in the window
  // does not win over one that happens four times just for being there more often.
  const firstStart = cycles.length ? Math.min(...cycles.map((cycle) => cycle.startedAt)) : now;
  const spanDays = Math.min(MAX_DAYS_COUNTED, Math.max(1, Math.round((now - (days ? since : firstStart)) / DAY_MS)));
  const weekdayDays = new Array(7).fill(0);
  for (const midnight of recentLocalDayStarts(new Date(now), spanDays, timeZone)) weekdayDays[slotOf(midnight + 12 * HOUR_MS).weekday] += 1;
  const weekdayRates = weekdayStarts.map((count, index) => count / Math.max(1, weekdayDays[index]));

  const enough = cycles.length >= MIN_CYCLES;
  const weekday = enough ? peak(weekdayRates, weekdaySeconds) : -1;
  const hour = enough ? peak(hourStarts, hourSeconds) : -1;
  const totalSeconds = sum(hourSeconds);
  const daySeconds = sum(hourSeconds.slice(DAY_FIRST_HOUR, NIGHT_FIRST_HOUR));
  const dayShare = enough && totalSeconds > 0 ? Math.round((daySeconds / totalSeconds) * 100) : null;
  const round = (matrix) => matrix.map((row) => row.map((value) => Math.round(value)));
  const power = powerWeighted.map((row, day) => row.map((value, hourOfDay) => (powerSeconds[day][hourOfDay] > 0 ? Math.round(value / powerSeconds[day][hourOfDay]) : 0)));
  // The hour of the day with the highest average power while on, across all weekdays.
  const hourPower = Array.from({ length: 24 }, (_, hourOfDay) => {
    const weight = sum(powerSeconds.map((row) => row[hourOfDay]));
    return weight > 0 ? sum(powerWeighted.map((row) => row[hourOfDay])) / weight : 0;
  });
  const powerHour = enough ? peak(hourPower, hourSeconds) : -1;
  const totalEnergy = sum(energy.map(sum));
  return {
    period, enough, cycleCount: cycles.length, minCycles: MIN_CYCLES,
    starts, seconds: round(seconds), energy: energy.map((row) => row.map((value) => Math.round(value * 1000) / 1000)), power,
    totalEnergy: Math.round(totalEnergy * 1000) / 1000, peakPowerHour: powerHour >= 0 ? powerHour : null, peakPower: powerHour >= 0 ? Math.round(hourPower[powerHour]) : null,
    weekdayStarts, weekdaySeconds: weekdaySeconds.map(Math.round), hourStarts, hourSeconds: hourSeconds.map(Math.round),
    busiestWeekday: weekday >= 0 ? weekday : null, busiestWeekdayShare: weekday >= 0 ? Math.round((weekdayStarts[weekday] / cycles.length) * 100) : null,
    busiestHour: hour >= 0 ? hour : null,
    dayShare, nightShare: dayShare === null ? null : 100 - dayShare
  };
}

// Intl wants 'nb' for Norwegian Bokmal; everything else the app offers is its own code.
function weekdayName(index, language) {
  const locale = language === 'no' ? 'nb' : language;
  try { return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1 + index)); } // 2024-01-01 was a Monday
  catch (error) { return new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1 + index)); }
}

const pad = (hour) => String(hour).padStart(2, '0');
function hourLabel(hour) { return `${pad(hour)}:00-${pad((hour + 1) % 24)}:00`; }

// The pattern with names and the sentence in the wanted language (`wording` is wordingFor(language).usagePatternMessages).
function describeUsagePattern(pattern, { name, language, wording }) {
  const base = { ...pattern, weekdayName: pattern.busiestWeekday === null ? '' : weekdayName(pattern.busiestWeekday, language), hourLabel: pattern.busiestHour === null ? '' : hourLabel(pattern.busiestHour), peakPowerHourLabel: pattern.peakPowerHour === null ? '' : hourLabel(pattern.peakPowerHour) };
  const message = pattern.enough
    ? renderMessage(wording.summary, { monitor: name, weekday: base.weekdayName, weekday_share: `${pattern.busiestWeekdayShare}%`, hour: base.hourLabel, day_share: `${pattern.dayShare}%` })
    : renderMessage(wording.notEnough, { monitor: name, count: pattern.cycleCount, needed: pattern.minCycles });
  return { ...base, message };
}

// The percent of a monitor's cycles that started in the local hour of `time`; null with too few cycles to say what is usual.
// The cycle running now is not in `cycles` yet (it is added when it ends), so it never counts toward its own hour.
function hourShare(monitor, { timeZone, time = Date.now() }) {
  const cycles = (monitor.cycles || []).filter((cycle) => Number.isFinite(cycle.startedAt));
  if (cycles.length < UNUSUAL_MIN_CYCLES) return null;
  const slotOf = localSlotter(timeZone);
  const hour = slotOf(time).hour;
  return (cycles.filter((cycle) => slotOf(cycle.startedAt).hour === hour).length / cycles.length) * 100;
}

module.exports = { hourShare, UNUSUAL_MIN_CYCLES, usagePattern, describeUsagePattern, weekdayName, hourLabel, MIN_CYCLES };
