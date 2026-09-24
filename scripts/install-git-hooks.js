'use strict';

// Recreates .git/hooks/post-commit, which refreshes build-info.json after every commit so the app's
// startup log line names the commit that was actually installed. Git hooks are not versioned, so a fresh
// clone (or a new machine) runs this once: `npm run hooks`.
const fs = require('fs');
const path = require('path');

const hooksDir = path.join(__dirname, '..', '.git', 'hooks');
if (!fs.existsSync(path.join(__dirname, '..', '.git'))) {
  console.error('No .git directory here; nothing to install.');
  process.exit(1);
}
fs.mkdirSync(hooksDir, { recursive: true });
const hook = path.join(hooksDir, 'post-commit');
fs.writeFileSync(hook, '#!/bin/sh\n# Installed by scripts/install-git-hooks.js\nnode scripts/write-build-info.js > /dev/null 2>&1 || true\n');
fs.chmodSync(hook, 0o755);
console.log(`Installed ${path.relative(process.cwd(), hook)}`);
