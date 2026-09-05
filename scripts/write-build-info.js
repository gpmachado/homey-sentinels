'use strict';

// Regenerates build-info.json from the current git HEAD — run automatically by the
// post-commit hook (.git/hooks/post-commit) so every "homey app run/install" right after a
// commit ships a fresh stamp, no workflow change needed. Safe to run manually too
// ("npm run stamp") while iterating on uncommitted changes.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
function git(cmd) {
  try { return execSync(cmd, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (error) { return null; }
}

const info = {
  commit: git('git rev-parse --short HEAD') || 'unknown',
  commitDate: git('git log -1 --format=%cI') || null,
  subject: git('git log -1 --format=%s') || null,
  dirty: Boolean(git('git status --porcelain')),
  stampedAt: new Date().toISOString()
};

fs.writeFileSync(path.join(repoRoot, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`build-info.json written: ${info.commit}${info.dirty ? ' (dirty)' : ''} — ${info.subject || ''}`);
