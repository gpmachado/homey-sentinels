'use strict';

const ACTIVE = 'ACTIVE';
const STANDBY = 'STANDBY';

// A gap this long between samples usually means Homey or the device was offline/rebooted,
// not that the previous state genuinely held for the whole span. Past this threshold the
// interval is discarded instead of being counted as hours of phantom activity/standby time.
const MAX_GAP_SECONDS = 4 * 60 * 60;

// Two monitor flavors share this one engine: a 'power' monitor (default) crosses a numeric
// threshold, a 'state' monitor just mirrors a boolean capability (a door, a presence sensor)
// directly — there's no meaningful threshold for "open/closed" to cross. Everything past this
// point (cycles, periods, grace windows, retention, median stats) is identical for both; only
// the raw ACTIVE/STANDBY decision differs.
function stateFor(monitor, power) {
  if (monitor.mode === 'state') return power ? ACTIVE : STANDBY;
  return Number(power) > Number(monitor.threshold) ? ACTIVE : STANDBY;
}

// A state monitor's session can be a few seconds (a door opened and shut) — rounding
// straight to minutes would show "0 min" for every one of those, indistinguishable from
// each other. Below a minute, show seconds instead; a power/energy cycle (typically minutes
// or hours) is unaffected since it's essentially never under a minute.
function humanDuration(seconds) {
  const safeSeconds = Math.max(0, Math.round(seconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  const minutes = Math.round(safeSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function average(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null; }
function maximum(values) { return values.length ? Math.max(...values) : null; }
// Robust to outliers where average() isn't — one abnormally long cycle pulls the mean with
// it, but leaves the median untouched. Mode isn't offered alongside these: duration/energy/
// power readings are continuous, so "most frequent exact value" is normally meaningless
// without first bucketing into ranges, which this app deliberately doesn't do.
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function numericValues(items, field) { return items.map((item) => item[field]).filter(Number.isFinite); }

// ACTIVE→STANDBY waits the longer of the two: "was this drop even real, or just noise"
// (minConfirmationSeconds) and "should a brief-but-real pause still count as one session"
// (continuityMinutes). Both just delay when the transition is acted on and get backdated to
// the original drop instant either way, so one combined threshold produces identical
// observable behavior to gating them one after the other.
function standbyGraceSeconds(monitor) { return Math.max((monitor.continuityMinutes || 0) * 60, monitor.minConfirmationSeconds || 0); }

class ActivityEngine {
  processSample(monitor, { power, energy = null, current = null, timestamp = Date.now() }) {
    const rawState = stateFor(monitor, power);
    const previous = monitor.lastSample;
    const events = [];
    if (previous) {
      const elapsedSeconds = Math.max(0, (timestamp - previous.timestamp) / 1000);
      if (elapsedSeconds > MAX_GAP_SECONDS) {
        // Treat the reconnection as a clean restart of the current cycle rather than
        // attributing the unknown downtime to it.
        if (monitor.state === ACTIVE) monitor.activeSince = timestamp;
      } else {
        // An interval is represented by its opening sample. The closing sample only
        // tells us that the following interval has changed state.
        monitor.totals[monitor.state === ACTIVE ? 'activeSeconds' : 'standbySeconds'] += elapsedSeconds;
        // A negative raw delta means the meter was reset/replaced, not that consumption was
        // negative — clamped to 0 either way (unchanged behavior), but now flagged instead of
        // silently looking identical to "genuinely measured zero" for this interval.
        const rawDelta = Number.isFinite(energy) && Number.isFinite(previous.energy) ? energy - previous.energy : null;
        const meterReset = rawDelta !== null && rawDelta < 0;
        const energyDelta = rawDelta !== null ? Math.max(0, rawDelta) : null;
        if (energyDelta !== null) {
          const delta = energyDelta;
          monitor.totals[monitor.state === ACTIVE ? 'activeEnergy' : 'standbyEnergy'] += delta;
        }
        monitor.periods ||= [];
        monitor.periods.push({ startedAt: previous.timestamp, endedAt: timestamp, state: monitor.state, seconds: elapsedSeconds, energy: energyDelta, power: previous.power, current: previous.current, meterReset });
        // Keep enough local history for comparisons while avoiding unbounded settings growth.
        const retention = timestamp - 90 * 24 * 60 * 60 * 1000;
        monitor.periods = monitor.periods.filter((period) => period.endedAt >= retention);
      }
    }

    if (monitor.state === STANDBY && rawState === ACTIVE) {
      const confirmSeconds = monitor.minConfirmationSeconds || 0;
      if (confirmSeconds > 0) {
        if (!monitor.pendingActiveSince) {
          // A single reading above the threshold could be noise/flapping — wait for it to
          // hold before confirming a real start. No timer needed here (unlike the standby
          // side): a device that's genuinely turning on will keep reporting samples within
          // this short a window; one that doesn't was noise anyway.
          monitor.pendingActiveSince = timestamp;
        } else if ((timestamp - monitor.pendingActiveSince) / 1000 >= confirmSeconds) {
          this._confirmActive(monitor, monitor.pendingActiveSince, power, events);
        }
      } else {
        this._confirmActive(monitor, timestamp, power, events);
      }
    } else if (monitor.state === STANDBY && rawState === STANDBY && monitor.pendingActiveSince) {
      monitor.pendingActiveSince = null; // dropped back before confirming — was noise
    } else if (monitor.state === ACTIVE && rawState === STANDBY) {
      const graceSeconds = standbyGraceSeconds(monitor);
      if (graceSeconds > 0) {
        if (!monitor.pendingStandbySince) {
          // Also covers a variable-load device's brief pause between phases (washer/dryer) —
          // hold the transition open instead of closing the cycle immediately, and let app.js
          // schedule a real timer for it: if no further sample ever arrives (power drops and
          // just stays there), nothing would otherwise wake this engine up to resolve it.
          monitor.pendingStandbySince = timestamp;
          events.push({ type: 'continuity_pending', timestamp });
        } else if ((timestamp - monitor.pendingStandbySince) / 1000 >= graceSeconds) {
          this._finalizeStandby(monitor, monitor.pendingStandbySince, power, events);
        }
        // else: still within the grace window — stay ACTIVE, no event yet.
      } else {
        this._finalizeStandby(monitor, timestamp, power, events);
      }
    } else if (monitor.state === ACTIVE && rawState === ACTIVE && monitor.pendingStandbySince) {
      // Power recovered before the grace window expired — the session was never interrupted.
      monitor.pendingStandbySince = null;
    }

    monitor.lastSample = { power: Number(power), energy: Number.isFinite(energy) ? Number(energy) : null, current: Number.isFinite(current) ? Number(current) : null, timestamp };
    return events;
  }

  // Called from a timer scheduled when a continuity/confirmation grace window opens (see
  // 'continuity_pending' above), in case no further capability update ever arrives to let
  // processSample notice the window has expired on its own.
  finalizePendingStandby(monitor, now) {
    if (!monitor.pendingStandbySince) return [];
    if ((now - monitor.pendingStandbySince) / 1000 < standbyGraceSeconds(monitor)) return [];
    const events = [];
    this._finalizeStandby(monitor, monitor.pendingStandbySince, monitor.lastSample?.power, events);
    return events;
  }

  // Manual override for devices with no meaningful power/standby signal at all (a pure
  // on/off pump or switch) — driven by whatever Flow logic the user already has (e.g. a
  // native "Power becomes greater than X" trigger, or an on/off capability change), instead
  // of this engine's own threshold crossing. Bypasses continuity/confirmation grace windows
  // entirely: those exist to filter noise out of a raw numeric sample, but a manual command is
  // never noisy — it's an explicit "this session started/ended now". No-ops if the monitor is
  // already in the requested state, so wiring the same trigger twice can't double-count a cycle.
  startNow(monitor, timestamp = Date.now()) {
    const events = [];
    if (monitor.state === ACTIVE) return events;
    monitor.pendingActiveSince = null;
    this._closePreTransitionGap(monitor, timestamp);
    this._confirmActive(monitor, timestamp, monitor.lastSample?.power ?? null, events);
    return events;
  }
  stopNow(monitor, timestamp = Date.now()) {
    const events = [];
    if (monitor.state !== ACTIVE) return events;
    monitor.pendingStandbySince = null;
    this._closePreTransitionGap(monitor, timestamp);
    this._finalizeStandby(monitor, timestamp, monitor.lastSample?.power ?? null, events);
    return events;
  }
  // startNow/stopNow force a state change outside processSample's normal sample-by-sample
  // flow. Without this, the *next* real processSample call would compute its elapsed-time
  // period against monitor.lastSample.timestamp — which can be from well before this manual
  // transition — and tag that entire stale gap with the state AFTER the transition (confirmed
  // live: a manual start_activity left monitor.lastSample untouched, so the following power
  // reading created one ~1000s period covering mostly-standby time but flagged ACTIVE, since
  // monitor.state had already flipped). Closing the gap here first attributes it to whichever
  // state was actually true throughout it — no energy reading exists exactly at `timestamp`,
  // so the synthetic period carries none rather than fabricating one.
  _closePreTransitionGap(monitor, timestamp) {
    const previous = monitor.lastSample;
    if (!previous) return;
    const elapsedSeconds = Math.max(0, (timestamp - previous.timestamp) / 1000);
    if (elapsedSeconds > 0 && elapsedSeconds <= MAX_GAP_SECONDS) {
      monitor.totals[monitor.state === ACTIVE ? 'activeSeconds' : 'standbySeconds'] += elapsedSeconds;
      monitor.periods ||= [];
      monitor.periods.push({ startedAt: previous.timestamp, endedAt: timestamp, state: monitor.state, seconds: elapsedSeconds, energy: null, power: previous.power, current: previous.current, meterReset: false });
      const retention = timestamp - 90 * 24 * 60 * 60 * 1000;
      monitor.periods = monitor.periods.filter((period) => period.endedAt >= retention);
    }
    monitor.lastSample = { ...previous, timestamp };
  }

  _confirmActive(monitor, startTimestamp, power, events) {
    monitor.pendingActiveSince = null;
    monitor.totals.cycleCount += 1;
    monitor.activeSince = startTimestamp;
    monitor.state = ACTIVE;
    events.push({ type: 'started', power, timestamp: startTimestamp });
  }

  _finalizeStandby(monitor, endTimestamp, power, events) {
    if (!monitor.activeSince) return;
    const duration = Math.max(0, (endTimestamp - monitor.activeSince) / 1000);
    const cyclePeriods = (monitor.periods || []).filter((period) => period.startedAt >= monitor.activeSince && period.startedAt < endTimestamp && period.state === ACTIVE);
    const averagePower = average(numericValues(cyclePeriods, 'power'));
    const maxPower = maximum(numericValues(cyclePeriods, 'power'));
    const averageCurrent = average(numericValues(cyclePeriods, 'current'));
    const maxCurrent = maximum(numericValues(cyclePeriods, 'current'));
    const cycleEnergy = numericValues(cyclePeriods, 'energy').reduce((total, value) => total + value, 0);
    monitor.cycles.push({ startedAt: monitor.activeSince, endedAt: endTimestamp, duration, averagePower, maxPower, averageCurrent, maxCurrent, energy: cycleEnergy });
    events.push({ type: 'finished', power, timestamp: endTimestamp, duration, duration_human: humanDuration(duration), energy: cycleEnergy, average_power: averagePower, max_power: maxPower, average_current: averageCurrent, max_current: maxCurrent });
    monitor.activeSince = null;
    monitor.pendingStandbySince = null;
    monitor.state = STANDBY;
  }
}

module.exports = { ACTIVE, STANDBY, ActivityEngine, stateFor, humanDuration, average, maximum, median, standbyGraceSeconds };
