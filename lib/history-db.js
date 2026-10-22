'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

// Error codes (SQLite's base ones) that say the file itself cannot be used as a database.
// node:sqlite may report an extended code, so only the low byte is compared.
// Anything else (e.g. 14, CANTOPEN for a missing directory) says nothing about the file itself.
const UNUSABLE = new Set([
  10, // IOERR
  11, // CORRUPT
  26 // NOTADB
]);

function isUnusableFile(err) {
  return Number.isInteger(err && err.errcode) && UNUSABLE.has(err.errcode & 0xff);
}

const oneLine = (err) => String((err && err.message) || err).split('\n')[0];

// Opens the file, applies the settings and prepares the statements.
// Throws on any failure, after releasing the handle.
function setUp(DatabaseSync, location, log) {
  const db = new DatabaseSync(location);
  try {
    const memory = location === ':memory:';
    db.exec('PRAGMA cache_size = -2048'); // negative means KiB: keep the page cache near 2 MB
    if (!memory) {
      // The pragma answers with the mode actually granted instead of throwing.
      const granted = db.prepare('PRAGMA journal_mode = WAL').get();
      const wal = String((granted && granted.journal_mode) || '').toLowerCase() === 'wal';
      // NORMAL is only crash-safe on flash with WAL, so fall back to FULL without it.
      db.exec(`PRAGMA synchronous = ${wal ? 'NORMAL' : 'FULL'}`);
      if (!wal) log('history database: write-ahead logging was not granted, using full synchronous mode');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS series (
      monitor TEXT NOT NULL,
      tag TEXT NOT NULL,
      idx INTEGER NOT NULL,
      row TEXT NOT NULL,
      PRIMARY KEY (monitor, tag, idx)
    ) WITHOUT ROWID`);
    return {
      db,
      statements: {
        load: db.prepare('SELECT row FROM series WHERE monitor = ? AND tag = ? ORDER BY idx'),
        monitors: db.prepare('SELECT DISTINCT monitor FROM series'),
        upsert: db.prepare('INSERT OR REPLACE INTO series (monitor, tag, idx, row) VALUES (?, ?, ?, ?)'),
        clear: db.prepare('DELETE FROM series WHERE monitor = ? AND tag = ?'),
        dropMonitor: db.prepare('DELETE FROM series WHERE monitor = ?')
      }
    };
  } catch (err) {
    try { db.close(); } catch { /* already unusable */ }
    throw err;
  }
}

// Moves the file and its sidecars to a name no later quarantine can reuse. Returns the new main name.
function quarantine(location) {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  // Prefix, not suffix: the name must not look like a sidecar of the live file.
  const target = path.join(path.dirname(location), `damaged-${stamp}-${path.basename(location)}`);
  fs.renameSync(location, target);
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.renameSync(location + suffix, target + suffix);
    } catch (err) {
      // A stray sidecar left behind would be replayed against the new database.
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return target;
}

function openHistoryDb(location, { log = () => {} } = {}) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (err) {
    log(`history database unavailable: node:sqlite cannot be loaded (${oneLine(err)})`);
    return null;
  }

  let opened;
  try {
    opened = setUp(DatabaseSync, location, log);
  } catch (err) {
    if (!isUnusableFile(err)) {
      log(`history database cannot be opened at ${location}: ${oneLine(err)}`);
      return null;
    }
    try {
      const kept = quarantine(location);
      opened = setUp(DatabaseSync, location, log);
      log(`history database at ${location} was unusable (${oneLine(err)}); kept as ${kept}, started a new one`);
    } catch (err2) {
      log(`history database at ${location} was unusable (${oneLine(err)}) and could not be replaced: ${oneLine(err2)}`);
      return null;
    }
  }

  const { db, statements } = opened;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error('history database is closed');
  };

  const api = {
    upsert: (monitor, tag, idx, value) => { statements.upsert.run(monitor, tag, idx, JSON.stringify(value)); },
    clear: (monitor, tag) => { statements.clear.run(monitor, tag); },
    dropMonitor: (monitor) => { statements.dropMonitor.run(monitor); }
  };

  return {
    location,

    load(monitor, tag) {
      assertOpen();
      return statements.load.all(monitor, tag).map((r) => JSON.parse(r.row));
    },

    monitors() {
      assertOpen();
      return statements.monitors.all().map((r) => r.monitor);
    },

    transaction(work) {
      assertOpen();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work(api);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        // The original error matters more than a failed rollback (which also means no transaction is open).
        try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
    },

    sizeBytes() {
      let total = 0;
      for (const file of [location, `${location}-wal`]) {
        try { total += fs.statSync(file).size; } catch { /* missing counts as 0 */ }
      }
      return total;
    },

    checkpoint() {
      if (closed) return false;
      try {
        // busy = 1 means the checkpoint could not complete.
        const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        return !result || result.busy === 0;
      } catch {
        return false;
      }
    },

    close() {
      if (closed) return;
      closed = true;
      try { db.close(); } catch { /* closing twice or on a broken file is harmless */ }
    }
  };
}

module.exports = { openHistoryDb };
