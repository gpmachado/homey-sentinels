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

function average(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null; }

// Only gates the return-to-NORMAL side — see the class doc on why the abnormal side has no
// equivalent wait.
function stabilizationGraceSeconds(monitor) { return (monitor.stabilizationMinutes || 0) * 60; }

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
      monitor.periods.push({ startedAt: previous.timestamp, endedAt: timestamp, seconds: elapsedSeconds, voltage: previous.voltage });
      const retention = timestamp - 90 * 24 * 60 * 60 * 1000;
      monitor.periods = monitor.periods.filter((period) => period.endedAt >= retention);
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
    const voltages = episodePeriods.map((period) => period.voltage).filter(Number.isFinite);
    const minVoltage = voltages.length ? Math.min(...voltages) : voltage;
    const maxVoltage = voltages.length ? Math.max(...voltages) : voltage;
    const averageVoltage = average(voltages);
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

module.exports = { NORMAL, UNDERVOLTAGE, OVERVOLTAGE, VoltageEngine, stateFor, average, stabilizationGraceSeconds };
