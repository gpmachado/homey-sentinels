'use strict';

const DEVICE_CACHE_REFRESH_MS = 5 * 60 * 1000;
// A Flow editor session types many letters into the same autocomplete; one list read serves them all.
const FLOW_LIST_MAX_AGE_MS = 15 * 60 * 1000;
const HISTORY_CONSOLIDATION_MS = 6 * 60 * 60 * 1000;
// Auxiliary capabilities are detected automatically from whatever the device exposes —
// the user only picks the device (and, if needed, overrides the primary capability).
// measure_power is here for state monitors' benefit (see add_state_monitor) — it's normally
// an activity monitor's own primary capability, so this only ever fires as "auxiliary" when
// the primary capability is something else (an activity monitor on measure_current, or any
// state monitor at all, whose primary is never a power reading).
const AUXILIARY_CAPABILITY_CANDIDATES = ['measure_power', 'measure_current', 'meter_power', 'measure_voltage'];
// Feeds the Timeline widget — a rolling feed of the most recent rendered event messages across
// every monitor, capped rather than time-retained since its only purpose is "what just
// happened", not historical analysis (that's what each monitor's own statistics are for).
const EVENT_LOG_MAX = 50;
// Groups have no per-device subscription (see _checkGroup) — a light periodic poll instead of
// a full live-subscription rewrite gets 80% of the value (a daily "how much of today was this
// group mismatched" stat) for a fraction of the complexity. 5 minutes matches
// DEVICE_CACHE_REFRESH_MS's own cadence — frequent enough to be useful, infrequent enough that
// even several groups' worth of getDevice() calls per tick stays negligible.
const GROUP_POLL_INTERVAL_MS = 5 * 60 * 1000;
// Same polling rationale as groups — availability watchdogs check `available`/`lastSeenAt` off
// the existing device cache, no new subscription. Thresholds are configured in hours, so this
// cadence just needs to be comfortably finer than the smallest threshold anyone would set.
const AVAILABILITY_POLL_INTERVAL_MS = 10 * 60 * 1000;
// Every raw capability sample across every monitor used to call store.save() synchronously —
// each one serializing and writing the ENTIRE settings blob (all monitors' periods/cycles
// combined, now 30k+ entries). Confirmed live: as that data volume grew, a burst of
// near-simultaneous samples (several monitors reporting close together) pushed cumulative save
// cost past Homey's CPU watchdog and crashed the app. Coalescing rapid saves into one write
// every this long fixes the scaling problem — store.save() always persists the current
// `this.data` wholesale, so any number of mutations before the timer fires are captured by
// that one eventual write regardless.
const SAVE_DEBOUNCE_MS = 15000;
const SUMMARY_CACHE_MS = 5000;
const WIDGET_LIST_MAX = 30;
const WATCHDOG_MISSING_POLLS = 3;
// A group member is taken out of its group after being missing from Homey for this many polls in a row.
const GROUP_MISSING_POLLS = 3;
const WATCHDOG_CHECK_MIN_MS = 15 * 1000;
// A calibrating monitor re-attempts _suggestedThreshold on every sample — cheap for a device
// that reports every few minutes, but a device cycling rapidly (a heating element's thermostat
// clicking on/off) can push many samples per second, each re-sorting the whole periods[]
// array. Confirmed live: this hit Homey's own CPU limit and crashed the app. A per-monitor
// cooldown bounds the sort to at most once per this interval, regardless of sample rate.
const CALIBRATION_RETRY_MS = 60 * 1000;
const CALIBRATION_MAX_RETRY_MS = 30 * 60 * 1000;
// MEDIAN_MIN_CYCLES, THRESHOLD_SUGGESTION_MIN_SAMPLES/MIN_GAP_RATIO, and GROUP_TYPES now live in
// lib/statistics.js and lib/groups.js respectively, alongside the functions that use them.
// Homey rejects a "number" Flow token whose value is null/undefined ("Invalid Token") —
// average()/maximum() legitimately return null for "no data yet". Only coerce at this
// Flow-token boundary; getWidgetSummary keeps reading the raw null to render "—" instead of "0".
const num = (value) => (Number.isFinite(value) ? value : 0);
// Energy is always stored/tokenized in kWh (matching Homey's meter_power capability), but a
// small appliance's single cycle is often a fraction of a kWh — "0.070 kWh" in a log line
// reads worse than "70 Wh". Human-readable log lines switch units dynamically; Flow tokens
// stay in kWh regardless, for predictable math across Flows.
const formatEnergy = (kwh) => (kwh < 1 ? `${Math.round(kwh * 1000)} Wh` : `${kwh.toFixed(2)} kWh`);

module.exports = { DEVICE_CACHE_REFRESH_MS, FLOW_LIST_MAX_AGE_MS, HISTORY_CONSOLIDATION_MS, AUXILIARY_CAPABILITY_CANDIDATES, EVENT_LOG_MAX, GROUP_POLL_INTERVAL_MS, AVAILABILITY_POLL_INTERVAL_MS, SAVE_DEBOUNCE_MS, SUMMARY_CACHE_MS, WIDGET_LIST_MAX, WATCHDOG_MISSING_POLLS, GROUP_MISSING_POLLS, WATCHDOG_CHECK_MIN_MS, CALIBRATION_RETRY_MS, CALIBRATION_MAX_RETRY_MS, num, formatEnergy };
