# Git commit / PR attribution

Do not add `Co-Authored-By: Claude...` lines to commit messages, and do not add
the "🤖 Generated with Claude Code" line to PR descriptions.

## Codebase Overview

Sentinels is a read-only Homey Pro SDK3 app: it watches other apps' devices and reports through Flow cards, a Settings page and six widgets, and never sends a device command.

**Stack**: plain JavaScript on the Homey's Node 22, `homey-api`, `node:sqlite`, `node:test`.
**Structure**: `app.js` plus mixins in `lib/app/`, pure logic in `lib/`, routes in `api.js`, UI in `settings/` and `widgets/`, manifest source in `.homeycompose/` (`app.json` is generated).

For detailed architecture, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).
