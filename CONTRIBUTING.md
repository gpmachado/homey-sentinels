# Contributing to Sentinels

Thank you for taking the time to look at this. Sentinels is a small Homey Pro app (SDK v3, plain
CommonJS JavaScript, no build step) that only **observes** devices. This guide is what you need to
run it, change it and not break the things that took a while to get right.

Where to read first:

- [README.md](README.md) — what the app does.
- [HOWTO.md](HOWTO.md) — how each feature is used from Flows and Settings.
- [SPEC.md](SPEC.md) — architecture, data model, retention and the reasoning behind design choices.
- [TODO.md](TODO.md) — what is pending, what still has to be checked on a real Homey, and the list of
  things **decided against** (read it before proposing one of them again).

## Running it

You need Node.js 22 or newer, the Homey CLI (`npm i -g homey`) and a Homey Pro on the same network.

```bash
npm install            # once
npm test               # unit tests (node:test), no Homey needed
homey app validate     # builds .homeycompose/ into app.json and validates it
homey app run -r       # installs and runs the app on your Homey, streaming its log (Ctrl+C uninstalls)
npm run hooks          # once per clone: refreshes build-info.json after every commit (see below)
```

- The app **runs on the Homey**, not on your computer. Widgets and the Settings page only work there.
- The startup log line names the commit that was installed (`build abc1234+dirty`). It comes from
  `build-info.json`, which `npm run stamp` writes (the post-commit hook does it for you). If the log names an
  old commit, you are looking at an old build.
- `env.json` (gitignored, local only) holds debug switches, read as `Homey.env`. Today there is one:
  `{ "SENTINELS_MEMORY_LOG": "0" }` silences the periodic memory log lines.
- Homey apps run on **Node 22** with the built-in `node:sqlite` (that is what stores the history). The
  `ExperimentalWarning` about SQLite in the log is expected.

## How the code is laid out

```
app.js                    The App class: onInit, timers, event log, time zone, widget registration
api.js                    Web API routes used by the Settings page (see the rules below)
lib/app/*.js              The rest of the App's behaviour, one file per concern, mixed into the class
lib/*.js                  Pure logic and storage: engines, statistics, store, gateway, availability...
settings/                 The Settings page (plain HTML/CSS/JS, no framework)
widgets/<name>/           One dashboard widget each (widget.compose.json, api.js, public/index.html)
.homeycompose/            Source of app.json: Flow cards, API route list, app manifest
test/                     node:test suites
```

`app.json` at the root is **generated** from `.homeycompose/`. Edit the compose files, never `app.json`.

The App class is assembled from mixins: each file in `lib/app/` exports plain methods that
`app.js` copies onto the prototype, so they still use `this` (`this.store`, `this.gateway`, `this.homey`).
`test/app-structure.test.js` checks that every `this.x()` and `homey.app.x()` call in the code has a matching
method, so a typo or a method left in the wrong place fails the tests instead of failing on the Homey.

## Rules that exist because something broke

1. **Read-only.** Nothing may send a command to a device. The API permission is used only to read.
2. **Keep settings tiny.** `homey.settings.set` re-serialises the whole settings object on every write. The
   bulky history (periods, cycles) lives in SQLite under `/userdata` (`lib/history-db.js`); the store keeps
   only small metadata in settings. One character above U+00FF doubles the memory of every settings write, so
   default messages are plain ASCII (`lib/text.js`).
3. **Do not read the full device list casually.** The first full `getDevices()` costs memory that never comes
   back. It is read on demand through `DeviceDirectory`, and the availability scan reads it once per interval.
   Anything that needs one device uses `gateway.getDevice(id)`.
4. **Routes must not call the Homey API themselves.** A `getDevices()` from inside an API route never
   resolves. Wrap such work in `homey.app.inAppContext(() => ...)`, and do not wait for slow work in the route.
5. **Time is local, not UTC, when a person reads it.** Use `localTimeText` / the `time` token. `timestamp`
   tokens stay ISO/UTC for scripts. Day boundaries use `recentLocalDayStarts` (DST-safe), never "24 h ago".
6. **Widgets** poll every 30 s and pause when `document.hidden`; every widget folder needs
   `preview-light.png` and `preview-dark.png` (1024x1024) or validation fails.
7. **Changelog text** (`.homeychangelog.json`): no double quotes and no apostrophes. The Homey CLI builds a
   shell command from it for its own version-bump commit, and quotes break that command.
8. **Homey has no Portuguese** (or many other languages) in its own UI. Message templates are text the user
   writes in their own language on purpose; do not try to translate them through Homey's i18n.
9. **No new dependencies without a reason.** `homey-api` is the only one. Statistics are a few pure functions
   in `lib/statistics.js`; a library would cost files, memory and install time on a Homey.

## Adding things

**A new Flow card**: add its JSON under `.homeycompose/flow/{triggers,conditions,actions}/`, register the
handler in `lib/app/flow-cards.js` (the `action(...)`/`condition(...)` helpers log entry and result for free),
and mention it in HOWTO. A card that returns tokens only shows in Advanced Flow (a platform limit).

**A new Settings API route**: add the route to `.homeycompose/app.json` (`api`) **and** the function to
`api.js`; the names must match. Add a test in the style of `test/api-groups.test.js` (a fake `homey.app`).

**A new monitor type**, in order:
1. A store collection with a migration function in `lib/store.js` (older saved data must still load) and, if it
   has bulky series, an entry in `SERIES_COLLECTIONS` so it goes to SQLite.
2. An engine in `lib/` (pure, tested) that turns samples into events.
3. A runtime mixin in `lib/app/` that subscribes through the gateway, feeds the engine and fires triggers,
   resumed at startup with `resumeWithRetry`.
4. Creation/removal in `lib/app/monitor-admin.js`, Flow cards, API routes, a Settings tab, a widget summary.
5. A section in SPEC.md and HOWTO.md.

**A new widget**: copy the smallest existing folder in `widgets/`, give it `settings` in
`widget.compose.json` (users can change them after adding the widget) and a summary function in
`lib/widget-summaries.js` that is tested.

## Tests

`npm test` must pass, and CI runs it (Node 22) together with `homey app validate` on every push. New logic goes
into a pure function in `lib/` with a test; the mixins are tested with the real code and a fake gateway
(`test/groups-live.test.js` shows the pattern). The Settings HTML, the widgets and real device I/O are **not**
covered by tests; check those by hand with `homey app run -r` and say what you checked in the pull request.

## Commits and releases

- One topic per commit, with a message that says *why*, not only what.
- Version bump: `homey app version patch` (or `minor`), then `homey app publish`. Tag the released commit
  (`git tag -a v1.0.3 <commit> -m "Sentinels 1.0.3"`) and `git push --follow-tags`.
- Write a decision into SPEC.md or TODO.md when you make one. The "decided against" list in TODO.md exists so
  the same good-looking idea is not rebuilt twice.

## Bug reports and feature requests

A useful bug report has the app version (the startup log line), the steps, the log around the moment, and what
you expected. A useful feature request says who needs it and why, and what it would cost (memory, polling,
settings size), because those costs are what shape this app.
