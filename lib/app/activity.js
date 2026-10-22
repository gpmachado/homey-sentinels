'use strict';

// Activity monitors at runtime: subscribing, sampling, calibrating and reacting to cycle events.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { humanDuration, standbyGraceSeconds } = require('../activity-engine');
const { renderMessage } = require('../message-template');
const { analyzeThreshold: computeAnalyzeThreshold, thresholdFromReadings } = require('../statistics');
const { applyBackfill } = require('../insights-replay');
const { CALIBRATION_RETRY_MS, CALIBRATION_MAX_RETRY_MS, num, formatEnergy } = require('./constants');

const { localTimeText } = require('../time');

// The Insights window the history is rebuilt from; one place to change it.
const INSIGHTS_REBUILD_RESOLUTION = 'last7Days';

module.exports = {
  async _watch(monitor) {
    await this.gateway.subscribeCapabilities(monitor.id, monitor.deviceId, monitor.capability, monitor.auxiliaryCapabilities, async (power, timestamp, device) => this._sample(monitor, power, timestamp, device));
  },

  async _sample(monitor, power, timestamp, device) {
    const energy = device?.capabilitiesObj?.meter_power?.value;
    const current = device?.capabilitiesObj?.measure_current?.value;
    const events = this.engine.processSample(monitor, { power, timestamp, energy, current });
    await this._handleActivityEvents(monitor, events);
    // Only a plain threshold monitor (no mode) still refining its DEFAULT_ACTIVITY_THRESHOLD
    // fallback auto-calibrates — 'state' mirrors a boolean and 'manual' never looks at a
    // threshold at all, see stateFor() in activity-engine.js.
    if (monitor.calibrating && !monitor.mode) await this._maybeAutoCalibrate(monitor);
  },

  // Lets "Add activity monitor" work from just a device — no Watts guess needed. A monitor
  // created without a threshold starts immediately usable at DEFAULT_ACTIVITY_THRESHOLD
  // (SentinelStore) instead of sitting inert, flagged `calibrating` while it collects raw power
  // samples until there's enough history for _suggestedThreshold to find a confident
  // standby/active gap — then replaces the fallback and fires "Threshold calibrated" once so
  // the user knows what value was picked, reusing the exact same gap-detection already backing
  // the Settings page's passive suggestion.
  async _maybeAutoCalibrate(monitor) {
    const now = Date.now();
    const lastAttempt = this._lastCalibrationAttempt.get(monitor.id);
    const attempts = this._calibrationAttempts.get(monitor.id) || 0;
    // Each failed attempt sorts every raw power value of the monitor; a device that never shows two
    // clearly separated levels (a well pump idles at 0 W) failed every minute forever. Back off
    // 1, 2, 4 ... up to 30 minutes between tries, and log only the first few and then every tenth.
    const waitMs = Math.min(CALIBRATION_RETRY_MS * 2 ** attempts, CALIBRATION_MAX_RETRY_MS);
    if (lastAttempt && now - lastAttempt < waitMs) return;
    this._lastCalibrationAttempt.set(monitor.id, now);
    this._calibrationAttempts.set(monitor.id, attempts + 1);
    const periodCount = (monitor.periods || []).length;
    if (attempts < 3 || attempts % 10 === 0) this.log(`[${monitor.name}] checking for a calibration threshold (${periodCount} power samples so far, attempt ${attempts + 1})`);
    const analysis = computeAnalyzeThreshold(monitor);
    const suggestion = analysis.suggestion;
    if (!suggestion) {
      // Says WHY it isn't confident (only on the attempts that are logged at all), so a monitor that
      // stays in "calibrating" can be diagnosed from the log rather than guessed at.
      if (attempts < 3 || attempts % 10 === 0) this.log(`[${monitor.name}] calibration not confident yet: ${analysis.reason} ${JSON.stringify(analysis.details)}`);
      return;
    }
    this._calibrationAttempts.delete(monitor.id);
    monitor.threshold = suggestion.threshold;
    monitor.calibrating = false;
    await this.store.save();
    this.log(`[${monitor.name}] calibrated: threshold ${suggestion.threshold} W (standby ~${suggestion.low} W, active ~${suggestion.high} W, ${suggestion.sampleCount} samples)`);
    const base = {
      device: monitor.deviceName, monitor: monitor.name, threshold: suggestion.threshold,
      standby_power: suggestion.low, active_power: suggestion.high
    };
    const data = { ...base, message: this._say('calibrated', { monitor: monitor.name, threshold: Math.round(suggestion.threshold), standby: Math.round(suggestion.low), active: Math.round(suggestion.high) }) };
    await this.cards.calibrated.trigger(data, { monitorId: monitor.id });
  },

  // A new monitor with no threshold starts on a default and has to collect its own readings before it can find the
  // real standby/active split, which for a device that runs a few times a day takes days. Homey's Insights already
  // logged what this device did, so the first threshold is read from that (the last 24 hours, then the last 7 days if
  // that is not enough). Only a starting value: the monitor stays `calibrating` and still replaces it as soon as its
  // own readings give a confident answer (_maybeAutoCalibrate). Never throws: no log, no API or no clear split just
  // leave the default.
  async _seedThresholdFromInsights(monitor) {
    for (const resolution of ['last24Hours', 'last7Days']) {
      let values;
      try {
        values = await this.gateway.getInsightValues(monitor.deviceId, monitor.capability, resolution);
      } catch (error) {
        this.log(`[${monitor.name}] no Insights history to start from (${error && error.message ? error.message : error})`);
        return false;
      }
      const suggestion = thresholdFromReadings(values);
      if (!suggestion) continue;
      // The monitor can have been deleted, or have finished calibrating on its own, while Insights was answering.
      if (this.store.data.monitors[monitor.id] !== monitor || !monitor.calibrating) return false;
      monitor.threshold = suggestion.threshold;
      await this.store.save();
      this.log(`[${monitor.name}] starting threshold ${suggestion.threshold} W from Homey Insights (${resolution}: standby ~${suggestion.low} W, active ~${suggestion.high} W, ${suggestion.sampleCount} readings); still calibrating from its own readings`);
      return true;
    }
    this.log(`[${monitor.name}] Homey Insights history shows no clear standby/active split yet; keeping the default threshold`);
    return false;
  },

  // Fills in the history from before this monitor existed (or before the app was running) from what Homey's Insights
  // logged: the same detection rules are replayed over those readings (lib/insights-replay.js) and the cycles and
  // periods they give are put in FRONT of what the monitor recorded itself. An estimate, and once per monitor until
  // it is reset. Throws a message the Settings page shows when there is nothing to rebuild from.
  async rebuildHistoryFromInsights(monitor) {
    if (monitor.mode) throw new Error('Only monitors that decide by a power threshold can be rebuilt from Insights.');
    const resolution = INSIGHTS_REBUILD_RESOLUTION;
    let entries;
    try {
      entries = await this.gateway.getInsightEntries(monitor.deviceId, monitor.capability, resolution);
    } catch (error) {
      throw new Error(`Homey Insights has no usable history for this device (${error && error.message ? error.message : error}).`, { cause: error });
    }
    if (this.store.data.monitors[monitor.id] !== monitor) throw new Error('The monitor was deleted meanwhile.');
    const result = applyBackfill(monitor, entries, { resolution });
    if (!result.applied) throw new Error('Homey Insights has no readings from before this monitor started recording, or none that show a cycle at the current threshold.');
    this.store.invalidateSeries();
    await this.store.save();
    this.log(`[${monitor.name}] history rebuilt from Homey Insights (${resolution}): ${result.readings} readings, ${result.cycles.length} cycles, ${result.periods.length} periods, ${new Date(result.from).toISOString()} to ${new Date(result.to).toISOString()}`);
    return { cycles: result.cycles.length, periods: result.periods.length, readings: result.readings, from: result.from, to: result.to };
  },

  // A continuity grace window (see activity-engine.js's 'continuity_pending') needs a real timer:
  // if power drops and simply stays there, no further capability update will ever arrive to let
  // processSample notice the window expired on its own.
  async _resolveContinuity(monitor) {
    const events = this.engine.finalizePendingStandby(monitor, Date.now());
    await this._handleActivityEvents(monitor, events);
  },

  // Returns the data for whichever 'started'/'finished' event actually fired (or null for a
  // pure 'continuity_pending' tick) — callers driving a manual start/stop (start_monitoring_device
  // / stop_monitoring_device) reuse this as their own action-card tokens, so the same power/
  // energy/current/message data is available in the same Flow without a second Flow listening
  // on "Activity started"/"Activity finished".
  async _handleActivityEvents(monitor, events) {
    this._scheduleSave();
    let result = null;
    for (const event of events) {
      if (event.type === 'continuity_pending') {
        this.homey.setTimeout(() => this._resolveContinuity(monitor).catch((error) => this.error('Failed to resolve continuity window', monitor.name, error)), standbyGraceSeconds(monitor) * 1000);
        continue;
      }
      // event.power is null for a manually-triggered start/stop (startNow/stopNow) on a
      // device with no numeric sample yet — coerce so the "power" number token never hits
      // the same "Invalid Token" null issue fixed elsewhere for the other stat tokens.
      const base = { device: monitor.deviceName, monitor: monitor.name, power: num(event.power), timestamp: new Date(event.timestamp).toISOString(), time: localTimeText(event.timestamp, this._getTimezone()) };
      if (event.type === 'started') {
        this.log(`[${monitor.name}] started (${num(event.power)} W)`);
        const startedData = { ...base, message: renderMessage(monitor.messageTemplateStarted, base) };
        await this.cards.started.trigger(startedData, { monitorId: monitor.id });
        this._logEvent(startedData.message);
        result = startedData;
      }
      if (event.type === 'finished') {
        this.log(`[${monitor.name}] finished (duration=${event.duration_human}, energy=${formatEnergy(num(event.energy))}, avg power=${num(event.average_power).toFixed(0)} W)`);
        // Today's cycle count already includes this cycle — _finalizeStandby pushed it to
        // cycles[] before this event was raised, so "%count%" reads naturally as "this is the
        // Nth time today" in a message like "pump turned off %count% %count:time|times% today".
        const dayStats = this._statistics(monitor, 'day');
        const finishedData = {
          ...base, duration: event.duration, duration_human: event.duration_human, energy: num(event.energy),
          average_power: num(event.average_power), max_power: num(event.max_power), average_current: num(event.average_current), max_current: num(event.max_current),
          count: dayStats.cycle_count, energy_today: num(dayStats.total_energy)
        };
        finishedData.message = renderMessage(monitor.messageTemplateFinished, finishedData);
        await this.cards.finished.trigger(finishedData, { monitorId: monitor.id });
        this._logEvent(finishedData.message);
        // dayStats.cycle_count strictly increases by exactly one per finished cycle, so an
        // exact-equality state match (see registerRunListener above) fires this precisely once
        // per Flow's configured count, not on every finish after crossing it.
        await this.cards.cyclesReached.trigger(
          { device: monitor.deviceName, monitor: monitor.name, count: dayStats.cycle_count, time: base.time, message: finishedData.message },
          { monitorId: monitor.id, cycleCount: dayStats.cycle_count }
        );
        // 'all' rather than 'day' for the baseline — cycles[] is never pruned, so this stays a
        // stable, meaningful median regardless of how long the monitor's been running; a small
        // cycle count (checked via median_duration being non-null, same MEDIAN_MIN_CYCLES guard
        // every other median-consuming stat already uses) simply doesn't fire yet.
        const allTimeStats = this._statistics(monitor, 'all');
        if (Number.isFinite(allTimeStats.median_duration) && allTimeStats.median_duration > 0) {
          const ratio = event.duration / allTimeStats.median_duration;
          await this.cards.unusuallyLong.trigger(
            { device: monitor.deviceName, monitor: monitor.name, duration: event.duration, duration_human: event.duration_human, median_duration: allTimeStats.median_duration, time: base.time, message: finishedData.message },
            { monitorId: monitor.id, ratio }
          );
        }
        result = finishedData;
      }
    }
    return result;
  },

  // Fallback tokens for start_monitoring_device/stop_monitoring_device when startNow/stopNow
  // was a no-op (monitor already in that state) — _handleActivityEvents returns null then,
  // but the action card still declares tokens and must always return a value for them.
  _startedSnapshot(monitor) {
    const base = { device: monitor.deviceName, monitor: monitor.name, power: num(monitor.lastSample?.power ?? null), timestamp: new Date().toISOString(), time: localTimeText(Date.now(), this._getTimezone()) };
    return { ...base, message: renderMessage(monitor.messageTemplateStarted, base) };
  },

  _finishedSnapshot(monitor) {
    const base = { device: monitor.deviceName, monitor: monitor.name, power: num(monitor.lastSample?.power ?? null), timestamp: new Date().toISOString(), time: localTimeText(Date.now(), this._getTimezone()) };
    const dayStats = this._statistics(monitor, 'day');
    const data = {
      ...base, duration: 0, duration_human: humanDuration(0), energy: 0, average_power: 0, max_power: 0, average_current: 0, max_current: 0,
      count: dayStats.cycle_count, energy_today: num(dayStats.total_energy)
    };
    return { ...data, message: renderMessage(monitor.messageTemplateFinished, data) };
  }
};
