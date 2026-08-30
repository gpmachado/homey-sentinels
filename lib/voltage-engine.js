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

class VoltageEngine {
  // Edge-triggered, like ActivityEngine: an event fires only on the state transition, never
  // per sample. A fluctuating reading that stays on the same side of the threshold (e.g.
  // 110 -> 108 -> 100, all under the minimum) never re-fires "started" — it only updates the
  // min/max observed for the episode, reported once the episode closes.
  processSample(monitor, { voltage, timestamp = Date.now() }) {
    const events = [];
    const isFirstSample = !monitor.lastSample;
    // The first-ever reading, and any reading still inside the stabilization window, only
    // establish the reference — matching the spec's rule against firing an isolated event
    // from the anomalous first point a voltage chart often has while it's still forming.
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

    if (monitor.state !== nextState) {
      if (nextState !== NORMAL) {
        // Track the episode's start even when suppressed, so a transition that begins during
        // the stabilization window still closes correctly once it later normalizes.
        monitor.eventSince = timestamp;
        monitor.eventType = nextState;
        if (!suppressed) events.push({ type: 'started', eventType: nextState, voltage, timestamp });
      } else if (monitor.eventSince) {
        const duration = Math.max(0, (timestamp - monitor.eventSince) / 1000);
        const episodePeriods = (monitor.periods || []).filter((period) => period.startedAt >= monitor.eventSince && period.startedAt < timestamp);
        const voltages = episodePeriods.map((period) => period.voltage).filter(Number.isFinite);
        const minVoltage = voltages.length ? Math.min(...voltages) : voltage;
        const maxVoltage = voltages.length ? Math.max(...voltages) : voltage;
        const averageVoltage = average(voltages);
        monitor.events ||= [];
        monitor.events.push({ type: monitor.eventType, startedAt: monitor.eventSince, endedAt: timestamp, duration, minVoltage, maxVoltage, averageVoltage });
        const eventsRetention = timestamp - 90 * 24 * 60 * 60 * 1000;
        monitor.events = monitor.events.filter((event) => event.endedAt >= eventsRetention);
        if (!suppressed) events.push({ type: 'normalized', previousEventType: monitor.eventType, voltage, timestamp, duration, min_voltage: minVoltage, max_voltage: maxVoltage, average_voltage: averageVoltage });
        monitor.eventSince = null;
        monitor.eventType = null;
      }
      monitor.state = nextState;
    }
    monitor.lastSample = { voltage: Number(voltage), timestamp };
    return events;
  }
}

module.exports = { NORMAL, UNDERVOLTAGE, OVERVOLTAGE, VoltageEngine, stateFor, average };
