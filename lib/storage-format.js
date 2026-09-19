'use strict';

// Compact on-disk encoding for the bulky time series (periods, cycles). Each row becomes a
// tuple of numbers instead of an object, so the JSON doesn't repeat every key name for every
// row (~3x smaller: 155 -> 48 bytes per voltage period) and, being plain ASCII, always
// serializes as a one-byte-per-char string. Conversion happens only at the save/load boundary;
// engines and statistics keep working on ordinary objects.
//
// A row is only turned into a tuple when it matches its schema exactly (every field present with
// an expected type, no extra keys). Anything else — a legacy shape, an unexpected value — is kept
// as-is, so the round trip is lossless for every row, not just the regular ones.

const ACTIVITY_STATES = ['STANDBY', 'ACTIVE'];
const VOLTAGE_STATES = ['NORMAL', 'UNDERVOLTAGE', 'OVERVOLTAGE'];

// kind: number = finite number | null, flag = boolean, state = index into `states`.
// `delta` marks a timestamp stored as an offset from the row's startedAt.
const SCHEMAS = {
  activityPeriod: {
    states: ACTIVITY_STATES,
    fields: [
      ['startedAt', 'time'], ['endedAt', 'delta'], ['state', 'state'], ['seconds', 'number'], ['energy', 'number'],
      ['minPower', 'number'], ['maxPower', 'number'], ['powerSum', 'number'], ['sampleCount', 'number'],
      ['maxCurrent', 'number'], ['currentSum', 'number'], ['currentSampleCount', 'number'], ['current', 'number'], ['meterReset', 'flag']
    ]
  },
  voltagePeriod: {
    states: VOLTAGE_STATES,
    fields: [
      ['startedAt', 'time'], ['endedAt', 'delta'], ['seconds', 'number'], ['state', 'state'],
      ['minVoltage', 'number'], ['maxVoltage', 'number'], ['voltageSum', 'number'], ['sampleCount', 'number']
    ]
  },
  cycle: {
    states: [],
    fields: [
      ['startedAt', 'time'], ['endedAt', 'delta'], ['duration', 'number'], ['averagePower', 'number'],
      ['maxPower', 'number'], ['averageCurrent', 'number'], ['maxCurrent', 'number'], ['energy', 'number']
    ]
  }
};

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function encodeRow(schema, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (Object.keys(row).length !== schema.fields.length) return null;
  const tuple = [];
  for (const [key, kind] of schema.fields) {
    const value = row[key];
    if (kind === 'time') {
      if (!isFiniteNumber(value)) return null;
      tuple.push(value);
    } else if (kind === 'delta') {
      if (!isFiniteNumber(value) || !isFiniteNumber(row.startedAt)) return null;
      const offset = value - row.startedAt;
      if (row.startedAt + offset !== value) return null; // not exactly reversible (non-integer ms) — keep the object
      tuple.push(offset);
    } else if (kind === 'number') {
      if (!(isFiniteNumber(value) || value === null)) return null;
      tuple.push(value);
    } else if (kind === 'flag') {
      if (typeof value !== 'boolean') return null;
      tuple.push(value ? 1 : 0);
    } else if (kind === 'state') {
      const index = schema.states.indexOf(value);
      if (index < 0) return null;
      tuple.push(index);
    }
  }
  return tuple;
}

function decodeRow(schema, tuple) {
  const row = {};
  schema.fields.forEach(([key, kind], i) => {
    const value = tuple[i];
    if (kind === 'delta') row[key] = tuple[0] + value;
    else if (kind === 'flag') row[key] = value === 1;
    else if (kind === 'state') row[key] = schema.states[value];
    else row[key] = value;
  });
  return row;
}

// Rows that don't fit the schema stay objects, so a decoded array can mix tuples (arrays) and
// plain objects; decodeRows tells them apart by Array.isArray.
function encodeRows(kind, rows) {
  const schema = SCHEMAS[kind];
  return (rows || []).map((row) => encodeRow(schema, row) || row);
}

function decodeRows(kind, encoded) {
  const schema = SCHEMAS[kind];
  return (encoded || []).map((entry) => (Array.isArray(entry) ? decodeRow(schema, entry) : entry));
}

module.exports = { encodeRows, decodeRows, SCHEMAS };
