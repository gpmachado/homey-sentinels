'use strict';

// Computes the UTC instant corresponding to local midnight in an IANA timezone, without
// pulling in a date library. Works by reading the wall-clock date in that zone, then
// correcting a UTC-midnight guess by the zone's offset at that instant.
function timezoneOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return (asUTC - date.getTime()) / 60000;
}

function startOfLocalDay(date, timeZone) {
  const dayKey = date.toLocaleDateString('en-CA', { timeZone }); // 'YYYY-MM-DD' in that zone
  const utcGuess = new Date(`${dayKey}T00:00:00Z`);
  const offsetMinutes = timezoneOffsetMinutes(timeZone, utcGuess);
  return new Date(utcGuess.getTime() - offsetMinutes * 60000);
}

// 'YYYY-MM-DD' for the given instant in a timezone — used to group raw samples into the
// calendar day they belong to for history consolidation.
function localDateKey(date, timeZone) { return date.toLocaleDateString('en-CA', { timeZone }); }

// The local-midnight instants of the last `days` calendar days, oldest first (the last one is
// today's). Steps back from one midnight to the previous by 12h into the middle of the prior day
// instead of subtracting 24h — a day is 23h/25h long across a DST change, so `midnight - N * 24h`
// lands on the wrong calendar day (or the wrong side of midnight) after one.
function recentLocalDayStarts(date, days, timeZone) {
  const starts = [];
  let start = startOfLocalDay(date, timeZone).getTime();
  for (let i = 0; i < days; i += 1) {
    starts.unshift(start);
    start = startOfLocalDay(new Date(start - 12 * 60 * 60 * 1000), timeZone).getTime();
  }
  return starts;
}

function isValidTimeZone(timeZone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; }
  catch { return false; }
}

module.exports = { startOfLocalDay, recentLocalDayStarts, timezoneOffsetMinutes, localDateKey, isValidTimeZone };
