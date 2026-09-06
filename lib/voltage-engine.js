'use strict';

const NORMAL = 'NORMAL';
const UNDERVOLTAGE = 'UNDERVOLTAGE';
const OVERVOLTAGE = 'OVERVOLTAGE';

function stateFor(voltage, minVoltage, maxVoltage) {
  const value = Number(voltage);
  if (value < minVoltage) return UNDERVOLTAGE;
  if (value > maxVoltage) return OVERVOLTAGE;
  return NORMAL;
}

// Only gates the return-to-NORMAL side — see the class doc on why the abnormal side has no
// equivalent wait.
function stabilizationGraceSeconds(monitor) { return (monitor.stabilizationMinutes || 0) * 60; }

// A capability like a Shelly's own voltage reading can push an update every few seconds —
// confirmed live at roughly one every 5-6 seconds, which turned into 13k+ raw periods within a
// single day and was a real, growing contributor to a recurring CPU/memory crash. Coalescing
// same-state samples into one period per this window (instead of one period per raw sample)
// cuts that volume by roughly BUCKET_MS/(observed sample interval) with no loss of the actual
// min/max that matters for daily summaries and episode severity — see _mergeSample below for
// why an average alone isn't safe here.
const VOLTAGE_BUCKET_MS = 60 * 1000;

class VoltageEngine {
  // Edge-triggered, like ActivityEngine: an event fires only on the state transition, never
  // per sample. The two directions are deliberately asymmetric: entering an abnormal state
  // (NORMAL -> under/over) fires immediately — catching a real problem fast matters more than
  // being cautious about it. Returning to NORMAL waits instead: it doesn't close the episode
  // the instant one reading lands back in range, it holds for `stabilizationMinutes` first
  // (mirrors ActivityEngine's standbyGraceSeconds/pendingStandbySince). A grid recovering from
  // a sag or surge routinely bounces across the line a few times before it actually settles —
  // without this, each bounce fragmented one real event into several short ones (confirmed
  // live: a single ~7-minute undervoltage produced 6 separate sub-minute episodes once the
  // monitor started reacting to every real sample). A reading that goes abnormal again during
  // that wait cancels the pending confirmation — the episode was never really over.
  processSample(monitor, { voltage, timestamp = Date.now() }) {
    const events = [];
    const isFirstSample = !monitor.lastSample;
    // The first-ever reading, and any reading still inside the one-time post-creation
    // stabilization window, only establish the reference — matching the spec's rule against
    // firing an isolated event from the anomalous first point a voltage chart often has while
    // it's still forming.
    const suppressed = isFirstSample || (monitor.stabilizedAt != null && timestamp < monitor.stabilizedAt);
    const nextState = stateFor(voltage, monitor.minVoltage, monitor.maxVoltage);

    if (!isFirstSample) {
      const previous = monitor.lastSample;
      const elapsedSeconds = Math.max(0, (timestamp - previous.timestamp) / 1000);
      monitor.periods ||= [];
      const lastPeriod = monitor.periods[monitor.periods.length - 1];
      // Coalesce into the previous period instead of pushing a new one when it's still within
      // the same bucket window AND the same state — never spanning a state transition matters:
      // _closeEpisode reads minVoltage/maxVoltage per period to report an episode's severity,
      // and a bucket straddling NORMAL and UNDERVOLTAGE would misattribute readings from before
      // the episode even started. Compare against each period's OWN recorded `state`, not
      // `monitor.state` read now — by the time this runs, `monitor.state` may already have been
      // flipped by the very same transition that just created `lastPeriod` a moment ago (in an
      // earlier call), which would wrongly look like a match and merge a pre-episode reading
      // into the episode. `stateAtStart` is `monitor.state` as it stood before anything in this
      // call could have mutated it — the state that was actually true for the interval now
      // being appended. Tracking real min/max (not an average) per bucket, plus a sum+count for
      // a true sample-weighted average later, means nothing downstream — daily summaries, an
      // episode's reported min/max — ever sees a smoothed-over value instead of what was
      // actually read; only the sub-bucket timing of individual samples is lost, which nothing
      // here ever used anyway.
      const stateAtStart = monitor.state;
      if (lastPeriod && lastPeriod.state === stateAtStart && (timestamp - lastPeriod.startedAt) < VOLTAGE_BUCKET_MS) {
        lastPeriod.endedAt = timestamp;
        lastPeriod.seconds += elapsedSeconds;
        lastPeriod.minVoltage = Math.min(lastPeriod.minVoltage, previous.voltage);
        lastPeriod.maxVoltage = Math.max(lastPeriod.maxVoltage, previous.voltage);
        lastPeriod.voltageSum += previous.voltage;
        lastPeriod.sampleCount += 1;
      } else {
        monitor.periods.push({
          startedAt: previous.timestamp, endedAt: timestamp, seconds: elapsedSeconds, state: stateAtStart,
          minVoltage: previous.voltage, maxVoltage: previous.voltage, voltageSum: previous.voltage, sampleCount: 1
        });
      }
      // periods are always appended in chronological order, so the oldest one is always
      // index 0 — checking just that one avoids re-filtering (allocating a whole new array
      // from) the entire list on every single sample, which is nearly always a no-op this
      // early in the app's life anyway. Confirmed live: with 13k+ periods on a fast-sampling
      // voltage capability, doing a full filter() per sample was a real, growing CPU cost
      // behind a recurring "CPU Warning Limit Reached" crash.
      const retention = timestamp - 90 * 24 * 60 * 60 * 1000;
      if (monitor.periods[0].endedAt < retention) monitor.periods = monitor.periods.filter((period) => period.endedAt >= retention);
    }

    if (nextState !== NORMAL && monitor.pendingNormalSince) {
      // Bounced back out before the grace window confirmed recovery — drop the pending
      // confirmation instead of closing the episode; it was noise, not a real return.
      monitor.pendingNormalSince = null;
    }

    if (monitor.state !== nextState) {
      if (nextState !== NORMAL) {
        // Track the episode's start even when suppressed, so a transition that begins during
        // the stabilization window still closes correctly once it later normalizes.
        monitor.eventSince = timestamp;
        monitor.eventType = nextState;
        if (!suppressed) events.push({ type: 'started', eventType: nextState, voltage, timestamp });
        monitor.state = nextState;
      } else if (monitor.eventSince) {
        const graceSeconds = stabilizationGraceSeconds(monitor);
        if (graceSeconds > 0) {
          if (!monitor.pendingNormalSince) {
            monitor.pendingNormalSince = timestamp;
            events.push({ type: 'continuity_pending', timestamp });
          } else if ((timestamp - monitor.pendingNormalSince) / 1000 >= graceSeconds) {
            this._closeEpisode(monitor, monitor.pendingNormalSince, voltage, suppressed, events);
          }
          // else: still within the grace window — stay in the abnormal state, no event yet.
        } else {
          this._closeEpisode(monitor, timestamp, voltage, suppressed, events);
        }
      } else {
        monitor.state = nextState;
      }
    }
    monitor.lastSample = { voltage: Number(voltage), timestamp };
    return events;
  }

  // Mirrors ActivityEngine#finalizePendingStandby — called from a timer scheduled when the
  // 'continuity_pending' event above fires, in case no further sample ever arrives to let
  // processSample notice the grace window expired on its own (a reading that's genuinely
  // stable again often stops producing new updates entirely).
  finalizePendingNormal(monitor, now) {
    if (!monitor.pendingNormalSince) return [];
    if ((now - monitor.pendingNormalSince) / 1000 < stabilizationGraceSeconds(monitor)) return [];
    const events = [];
    this._closeEpisode(monitor, monitor.pendingNormalSince, monitor.lastSample?.voltage, false, events);
    return events;
  }

  // Closes the current episode as of `endTimestamp` — backdated to when the reading actually
  // returned to normal (monitor.pendingNormalSince), not to whenever this runs, so the
  // confirmation wait itself never inflates the reported duration or pollutes min/max/average
  // with in-range confirmation samples.
  _closeEpisode(monitor, endTimestamp, voltage, suppressed, events) {
    const duration = Math.max(0, (endTimestamp - monitor.eventSince) / 1000);
    const episodePeriods = (monitor.periods || []).filter((period) => period.startedAt >= monitor.eventSince && period.startedAt < endTimestamp);
    // minVoltage/maxVoltage/voltageSum/sampleCount per bucket (see processSample) — falls back
    // to the old single-`voltage`-per-period shape for any period stored before this bucketing
    // was introduced (SentinelStore#load migrates those to the new shape too, but the fallback
    // costs nothing and keeps this function correct even if called before that migration runs).
    const mins = episodePeriods.map((period) => period.minVoltage ?? period.voltage).filter(Number.isFinite);
    const maxes = episodePeriods.map((period) => period.maxVoltage ?? period.voltage).filter(Number.isFinite);
    const totalSampleCount = episodePeriods.reduce((sum, period) => sum + (period.sampleCount ?? (Number.isFinite(period.voltage) ? 1 : 0)), 0);
    const totalVoltageSum = episodePeriods.reduce((sum, period) => sum + (period.voltageSum ?? (Number.isFinite(period.voltage) ? period.voltage : 0)), 0);
    const minVoltage = mins.length ? Math.min(...mins) : voltage;
    const maxVoltage = maxes.length ? Math.max(...maxes) : voltage;
    const averageVoltage = totalSampleCount ? totalVoltageSum / totalSampleCount : null;
    monitor.events ||= [];
    monitor.events.push({ type: monitor.eventType, startedAt: monitor.eventSince, endedAt: endTimestamp, duration, minVoltage, maxVoltage, averageVoltage });
    const eventsRetention = endTimestamp - 90 * 24 * 60 * 60 * 1000;
    monitor.events = monitor.events.filter((event) => event.endedAt >= eventsRetention);
    if (!suppressed) events.push({ type: 'normalized', previousEventType: monitor.eventType, voltage, timestamp: endTimestamp, duration, min_voltage: minVoltage, max_voltage: maxVoltage, average_voltage: averageVoltage });
    monitor.eventSince = null;
    monitor.eventType = null;
    monitor.pendingNormalSince = null;
    monitor.state = NORMAL;
  }
}

module.exports = { NORMAL, UNDERVOLTAGE, OVERVOLTAGE, VoltageEngine, stateFor, stabilizationGraceSeconds };
