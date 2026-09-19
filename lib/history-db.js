'use strict';

// The bulky time series (periods, cycles) live in a SQLite file under Homey's per-app /userdata
// directory instead of in homey.settings. ManagerSettings.set() re-serialises the WHOLE settings
// object on every write of any key, so a history of a few MB made every save cost tens of MB of
// heap churn (measured on a Homey Pro 2023). A write into /userdata crosses no serializer and no
// socket, and only the rows that changed are written. Same design as the PELS app
// (lib/store/userdataDatabase.ts). node:sqlite is built into the Node the Homey runs (v22.23 here).
//
// Rows keep the compact tuple encoding (storage-format.js) as text, keyed by (monitor, tag, index):
// the index is the row's position, which is stable because the engines only extend the LAST row in
// place or append; anything that shifts positions (folding old periods, compaction, reset) is seen
// as a count/first-row change and rewrites that one series.
const fs = require('fs');

const DAMAGED_RESULT_CODES = new Set([10, 11, 13, 26]); // IOERR, CORRUPT, FULL, NOTADB

function isDamaged(error) {
  const code = error && typeof error.errcode === 'number' ? error.errcode : null;
  return code !== null && DAMAGED_RESULT_CODES.has(code & 0xff);
}

function openWithPragmas(DatabaseSync, location, log) {
  const db = new DatabaseSync(location);
  try {
    // WAL: a power cut mid-commit leaves the last committed state, and NORMAL sync then avoids an
    // fsync per statement (measured here: 33 ms per single insert without it). NORMAL is only safe
    // in WAL mode, so the mode is verified and FULL is used when WAL is not granted.
    const mode = db.prepare('PRAGMA journal_mode = WAL').get();
    const journal = mode && typeof mode.journal_mode === 'string' ? mode.journal_mode.toLowerCase() : 'unknown';
    if (journal === 'wal' || location === ':memory:') db.exec('PRAGMA synchronous = NORMAL');
    else { log(`history database: WAL not available (${journal}), using synchronous FULL`); db.exec('PRAGMA synchronous = FULL'); }
    db.exec('PRAGMA cache_size = -2048'); // 2 MB page cache: it counts against the same memory ceiling
    db.exec('CREATE TABLE IF NOT EXISTS series (monitor TEXT NOT NULL, tag TEXT NOT NULL, idx INTEGER NOT NULL, row TEXT NOT NULL, PRIMARY KEY (monitor, tag, idx)) WITHOUT ROWID');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// A file SQLite refuses to open is set aside under a timestamped name and a fresh one started: the
// data is regenerable and a Homey Pro has no shell to repair it from.
function quarantine(location) {
  const suffix = `.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (const side of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${location}${side}`)) fs.renameSync(`${location}${side}`, `${location}${suffix}${side}`);
  }
  return `${location}${suffix}`;
}

// Opens (creating if needed) the history database. Returns null when SQLite or the directory is not
// available, so the caller can fall back to keeping the series in settings.
function openHistoryDb(location, { log = () => {} } = {}) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (error) {
    log(`history database unavailable: node:sqlite missing (${error.message})`);
    return null;
  }
  let db;
  try {
    db = openWithPragmas(DatabaseSync, location, log);
  } catch (error) {
    if (location !== ':memory:' && fs.existsSync(location) && isDamaged(error)) {
      try {
        log(`history database damaged, moved to ${quarantine(location)}; starting a new one`);
        db = openWithPragmas(DatabaseSync, location, log);
      } catch (again) {
        log(`history database unavailable: ${again.message}`);
        return null;
      }
    } else {
      log(`history database unavailable: ${error.message}`);
      return null;
    }
  }
  const statements = {
    load: db.prepare('SELECT row FROM series WHERE monitor = ? AND tag = ? ORDER BY idx'),
    upsert: db.prepare('INSERT INTO series (monitor, tag, idx, row) VALUES (?, ?, ?, ?) ON CONFLICT (monitor, tag, idx) DO UPDATE SET row = excluded.row'),
    clear: db.prepare('DELETE FROM series WHERE monitor = ? AND tag = ?'),
    dropMonitor: db.prepare('DELETE FROM series WHERE monitor = ?'),
    monitors: db.prepare('SELECT DISTINCT monitor FROM series')
  };
  let closed = false;
  const live = () => { if (closed) throw new Error('history database is closed'); return db; };
  return {
    location,
    // The stored rows of one series, parsed (each is a tuple array or, for a row that did not fit the
    // schema, a plain object).
    load(monitor, tag) { live(); return statements.load.all(monitor, tag).map((r) => JSON.parse(r.row)); },
    monitors() { live(); return statements.monitors.all().map((r) => r.monitor); },
    // Runs `work(api)` in one transaction; a throw rolls it back and rethrows.
    transaction(work) {
      const handle = live();
      handle.exec('BEGIN');
      try {
        const api = {
          upsert: (monitor, tag, idx, encoded) => statements.upsert.run(monitor, tag, idx, JSON.stringify(encoded)),
          clear: (monitor, tag) => statements.clear.run(monitor, tag),
          dropMonitor: (monitor) => statements.dropMonitor.run(monitor)
        };
        const result = work(api);
        handle.exec('COMMIT');
        return result;
      } catch (error) {
        handle.exec('ROLLBACK');
        throw error;
      }
    },
    // In WAL mode committed data sits in the -wal file until a checkpoint copies it into the main file,
    // so the main file alone (4 KB on a fresh database holding megabytes) says nothing about the size.
    sizeBytes() {
      let total = 0;
      for (const suffix of ['', '-wal']) { try { total += fs.statSync(`${location}${suffix}`).size; } catch (e) { /* absent */ } }
      return total;
    },
    // The two files separately: `main` is the database proper, `wal` is data committed since the last
    // checkpoint (it can hold several versions of the same page, so it overstates the real size).
    sizes() {
      const sizeOf = (suffix) => { try { return fs.statSync(`${location}${suffix}`).size; } catch (e) { return 0; } };
      return { main: sizeOf(''), wal: sizeOf('-wal') };
    },
    // Folds the WAL into the main file and empties it. Cheap; done after each consolidation so the
    // journal doesn't sit at its auto-checkpoint size and a killed app leaves less to recover.
    checkpoint() { try { live().exec('PRAGMA wal_checkpoint(TRUNCATE)'); return true; } catch (e) { return false; } },
    close() { if (!closed) { closed = true; db.close(); } }
  };
}

module.exports = { openHistoryDb };
