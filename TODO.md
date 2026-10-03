# TODO

### Idea: an in-Settings language switcher, independent of Homey.getLanguage() (2026-09-28)

Seen live in another app (MQTT Bridge): a small "English | Dansk" toggle in the corner of the
Settings page — its own stored preference, not tied to Homey's own configured system language.

To be clear, `locales/<lang>.json` + `Homey.__()` (what Voltage's and Group's default message
wording use today) is not a stopgap — it's the same standard mechanism the rest of the Settings
page's own text (currently plain English, hardcoded) would use if it's ever fully translated too,
so today's approach already lines up with that, no rework needed later. This idea is specifically
about Portuguese: Homey's officially supported languages don't include it, so no matter how complete
the app's translation into Homey's own supported languages gets, `Homey.__()`/`Homey.getLanguage()`
can never offer Portuguese defaults — that's a platform-language-list gap, not a translation-effort
gap.

A corner switcher like that, selecting between (at least) 2 languages, backed by an app setting
instead of the Homey platform language, would let Portuguese become a first-class option for the
default message wording (Voltage undervoltage/overvoltage/normalized, Group "Fill default wording")
alongside the other locales — not just a "Custom" fallback.

Important: this only changes where the *prefill* comes from. The free-text message field (Custom)
must stay editable exactly as it is today either way — "Fill default wording" only ever writes into
that same field on an explicit click (with a confirm if it's not empty), never locks it or replaces
it. A language switcher is an additional, better-targeted starting point, not a replacement for
typing your own message. Not started; a later idea, discussed but deliberately deferred rather than
built now.

### Open in the code, re-checked against it on 2026-10-02

Left over from the `/code-review max` of commit e25c760 (2026-09-28); the review was only a report, none of
these was fixed, and each was confirmed still present in the code today:
- **`activity_cost_exceeded` can skip a Flow for the rest of the day**: `previousCost` in `lib/app/activity.js:123`
  subtracts two values that were each already rounded to cents (`cost_today - cost`) instead of rounding the real
  previous total once, so a threshold that equals the exact previous amount can be missed.
- **`activity_cost_exceeded` with amount 0 can never fire**: `lib/app/flow-cards.js:90` tests
  `amount > previousCost` and `previousCost` is never below 0, yet the card allows `min: 0`.
- **Token colours and the Copy button's green "Copied!" never show**: `settings/style.css:83` sets
  `.container button { border/color ... !important }`, which beats the new non-`!important` category and
  `.is-copied` rules; the "Identification" category also has no rule at all. Same page: `TOKEN_INFO` defines
  tooltips for tokens that have no button in `settings/index.html` (dead entries).
- **`resumeWithRetry` only checks `isStillWanted()` when a retry fails** (`lib/resume.js:22`), never on success,
  so a monitor or group deleted / flagged missing while an attempt is in flight can still "start" and clear the
  flag. `lib/app/groups.js:93` also still has the old `isStillWanted` that only tests the group exists (monitors
  got the `&& !deviceMissing` half in `lib/app/monitor-admin.js`).
- **Calibration "ready" status has no UI branch**: `calibrationProgress()` can return `ready` (up to
  `CALIBRATION_MAX_RETRY_MS`, 30 min, not "momentary" as its comment says) but Settings only renders
  `collecting` and `inconclusive`. `analyzeThreshold` also runs twice per calibrating monitor per summary
  (suggested threshold + progress) and is now polled every 60 s by `refreshLiveStatus`, which duplicates
  `loadAll`'s endpoint wiring.
- **`voltage_phase_imbalance` throws on a deleted monitor** (`lib/app/flow-cards.js:290`, via
  `_voltageMonitor()`) instead of evaluating to false; its text says "more than N %" but the code uses `>=`.
- **`removeStateMonitor` leaks its auxiliary subscriptions** (`lib/app/monitor-admin.js:78` passes `[]`; only
  `removeVoltageMonitor` was fixed, with the Voltage `auxiliaryCapabilities` work).
- Commit e25c760 bundled several unrelated topics against CONTRIBUTING's "one topic per commit" (history, not code).

Done 2026-09-28 to 2026-10-02, to verify on the Homey: **Change device / Rename** on the Activity, State and Voltage
Edit forms (and that the new device's history starts clean while the old rows stay); Voltage messages with
**`%power%` / `%energy%`** on a combined meter (empty, not 0, on a device without power) and new Voltage monitors
starting with real default wording instead of blank (existing blank ones were left alone on purpose); Group
**Fill default wording** and new Voltage defaults in en/nl/de/fr/it/sv/no/es/da via `locales/` (the call
`Homey.__()` in Settings and `this.homey.__()` in the app were not seen working on a real Homey; both fall
back to English); the five **wireframe widget previews** (Sentinel's own preview is still the old realistic,
Portuguese one). Polish was drafted and pulled (flexion needs a native check). Binary Counter is to be removed in
the version after 1.0.7 (see below).

## Pending (2026-09-20)

### To verify on the Homey (built and unit-tested, not yet seen running)
- **Deleted device under a monitor**: the red "Device missing" badge in Settings (after the hourly scan or ~8 min
  after a restart), no more `Not Found` retries in the log; the first log line after start (`Watching: ...`).
- **P25 / P75 tokens** of "Get activity statistics" (need 5 cycles) and the weekly trend "not enough data".
- **"Set energy price"** action from a Flow (change the price, then finish a cycle and read the cost).
- **Health widget**: add "Sentinels Health"; the four rows, the coloured lights, the overall pill and the names.
- **Energy cost**: set a price and `R$`, finish a cycle of a monitor with energy data, and see `cost` / `%cost_text%`
  in the message and the Flow tokens; **decimal comma** in Settings -> Monitors -> Message format.
- **Deleted group member**: delete a device that is in a group. The poll should stop failing with `Not Found`,
  the group should keep working, and after 3 polls (or with **Clean up** / **Remove now** in Edit) the device
  should leave the group with a line in the event log.
- **Groups by event**: turn a member of "Fontes" off and the mismatch trigger / timeline entry should come at
  once (log line `group mismatch detected ...`), and again on turning it back on; try a quick off / on / off.
  Watch the PSS after start: about one subscription per member device was added (the three groups have 25 members).
- Availability tab: scan tiles and filters, **Scan now**, **Ignore** / **Ignore app** / include again, the
  amber **Silent N d** badge, low battery badge, the "Watchdog defaults" form (incl. scan on/off + interval),
  the "Device no longer in Homey" section and its cleanup button.
- Flow: `device_problem_detected` (fires once per new problem, first scan is silent), `device_battery_low`,
  Homey timeline entries, "wait after app start" and the "must stay unavailable N s" delay with its recheck.
- Widgets: Watchdogs (filter tiles, zone, **Check now**, title / only-down settings), Overview
  "Show every monitor" + kind filter, Voltage, the fixed Sentinel header; dark mode of all of them.
- Older, still unchecked: the group **Check** button, Flow autocompletes, the "ignore unavailable" checkbox,
  monitor resume retry after a failed start.
- Check the amber badge on "Motion Sensor Despensa" (silent since 13/09): possibly a dead sensor, not a false alarm.

### To build
- **Generate individual monitors** button on a Group (design in the section below; not started).
- **Ignore zone** in the Availability tab (the scan already honours excluded zones; only the button is missing).
- Widget settings like the Energy KPI Monitor's, editable after creation: Voltage (which monitors, period
  Day/Week/Month, view) and Overview (one list instead of five `monitorN` slots).
- Suggest the silence limit by device kind when adding a watchdog (battery sensor 24 h, mains plug 1 h).
- Scan option "silence only" per device (like a watchdog's `ignoreUnavailable`) instead of ignoring it entirely,
  and an `ignoreUnavailable` argument on the `add_availability_watchdog` Flow card.
- **Energy widget for the Shelly Pro** in the Energy KPI Monitor style: live W, kWh today / week / month, cost with a
  kWh price, top zone or consumers. (KPI Monitor is closed source; only its store page and settings are known.)
- More widgets: group members, running now, 24 h chart, compact badge; 365-day daily summaries / a "year" period.
- Sentinel Group virtual device (section below): the only view of a group in the web app.
- Docs were up to date as of 2026-09-23 but are NOT any more (checked 2026-10-02): README/HOWTO/SPEC say nothing about
  Change device / Rename on the Edit forms, the Voltage `%power%` / `%energy%` tokens, or the per-language default wording
  in `locales/`. Translating flow card titles to NL / DE is low priority (Homey has no Portuguese).
- Tests do not cover the Settings HTML, the widgets or real Homey I/O.

### Ideas collected 2026-09-24 (widgets, functions, analysis) - with the verdict of each

Order chosen: 1, 2, then 3, 4. Each was checked against what the app already keeps.

1. **"Home health" widget** (DONE 2026-09-24, to verify on the Homey: widget "Sentinels Health"): one card with the state of the house: devices with a problem
   (scan + watchdogs), monitors active now, voltage outside its band, groups in mismatch. Everything is in the
   store already (`_availabilityScan`, watchdogs, monitor `state`, `group.mismatchSince`), no API call.
2. **Estimated cost** (DONE 2026-09-24, to verify on the Homey: Settings -> Monitors -> Energy cost): a price per kWh (and currency symbol) in Settings; a `cost` token and
   `%cost%` in the message of finished cycles, and cost in the statistics tokens. Also feeds the Shelly Pro
   energy widget idea above.
3. **Top consumers / last cycles widget**: cycles already keep duration, energy and time; the day's energy per
   monitor is in `_statistics(monitor, 'day')`. Only for monitors that have energy data.
4. **Group status widget with live members**: the event-driven groups keep every member's value in memory
   (`_groupLive`), so a widget can show which member is out of place without any API call.
5. **Frequent / erratic cycling** trigger (pump or compressor turning on and off N times in M minutes): cycles
   have timestamps; needs a per-monitor limit, a new trigger and the fields in Settings.
6. **Baseline drift** (median duration / energy of the last 30 days against the 30 before, "maintenance
   suggested"): cycles are kept 365 days, so the data exists; only useful after about 60 days, and prone to
   false alarms, so later.
7. **Weekly house summary as text** (Flow action): `generate_text_report` exists but is per monitor or group and in
   English; a house-wide one needs a template the user writes, like the messages.
8. **MTBF per watchdog** ("goes offline on average every 14 days"): needs a short history of outages per device
   (last ~50 start/end pairs, tiny). **Availability sparkline** needs the same history; do them together.
9. Not now: **virtual summary devices** (driver work, memory, and groups are state-based, not power);
   **voltage drop / device offline correlation** (speculative, would invent links).
- Performance notes from the same review are already how the app works: calculations in memory with saves
  batched every 15 s and only changed history rows written to SQLite; widgets read the app's 5 s cache and
  pause when not on screen.

### Variable energy price (asked 2026-09-26)

Today one flat price per kWh (Settings -> Monitors -> Energy cost); with no price the cost tokens are 0 and the
texts empty, and `energy` (kWh) is always there for a Flow that does its own maths.
- **"Set energy price" Flow action** (DONE 2026-09-27, to verify on the Homey): a card that changes the price (and optionally the currency),
  so the user's own Flows handle time-of-use (18:00 set 1.20, 21:00 set 0.60) or a dynamic-tariff app's trigger.
  A cycle is priced at the price in force when it ends (a cycle that crosses a change is priced whole at the end
  price); say so in the card hint and HOWTO. No new permission.
- **Price schedule inside the app** (later, only if exactness is needed): price bands by weekday and hour, the
  cost of a cycle summed band by band from the periods (they keep energy with times, 7 days granular). Needs a
  real editor in Settings, so it costs much more.

Round of 2026-09-27: trend baseline floor, P25/P75 tokens, "Set energy price", cleanup of monitors of deleted
devices and the startup summary line are DONE (to verify on the Homey). Next: 4) Ignore zone, Generate individual
monitors, 5) top consumers / last cycles widget and the group members widget.

### Edit forms can't change a monitor's device or name (found live, 2026-09-28) — DONE

Swapping the Shelly 3EM's driver gave it a new Homey device id; the three Voltage monitors pointed at the
old one, which is now permanently gone (`deviceMissing`). There was no way to repoint an existing monitor at
a different device, or even just fix a typo in its name, without deleting it and recreating it from scratch
— which starts its history over (the old monitor's SQLite rows are orphaned, not carried across). The user
hit both in the same session: a typo in "Voltagem B" and the device swap both meant delete + recreate.

- **Change device**: the Edit form of an Activity/State/Voltage monitor now repoints `deviceId`/`deviceName`
  to a newly picked device (same capability required), keeping the monitor's id, history and settings.
- **Rename**: all three Edit forms now accept a `name`, validated the same way `updateGroup` already rejects
  a blank name.

Binary Counter still has no device (by design — it's a Flow-driven tally, not a capability monitor) and
still has no rename either (only its message template is editable). Decided 2026-09-28: not worth fixing —
remove Binary Counter entirely instead (deemed not useful), in the next version after 1.0.7. Removal touches
api.js (createBinaryCounter/deleteBinaryCounter/resetBinaryCounter/updateBinaryCounterMessage +
.homeycompose/app.json routes), lib/store.js (upsertBinaryCounter and its data), the Settings UI section,
the binary-counter Flow cards (add/remove/reset, log_binary_event, get_binary_event_statistics), and any
docs/TODO mentions — plus a migration note for existing users who already have binary counters configured.

### Round of 2026-09-27 (part 2): UX polish + two new Flow cards, checked against two AI reviews

Done:
- Token buttons in every "Message wording" form now show a category color (Identification/Time/Energy/
  Power/Cost/Count) and a hover tooltip (type + example); a "Copy" button next to each live preview copies
  the current rendered example. The %cost_text%/%time% tokens added earlier are covered by the preview data.
- Calibrating monitors show progress in Settings (samples collected, and once enough exist without a clear
  split, the closest standby/active split observed) instead of a bare spinner — `calibrationProgress()` in
  lib/statistics.js. A monitor with no completed cycle yet says so instead of showing blank stats.
- New trigger **activity_cost_exceeded** ("Cost today exceeds an amount"): fires once per amount per day,
  reusing the finished-cycle's own cost_today/cost — no new stored state (see SPEC "Cost threshold trigger").
- New condition **voltage_phase_imbalance** ("Two voltage monitors are more than N% apart"): compares two
  existing Voltage monitors' current readings; no new monitor type (see SPEC "Voltage phase imbalance").

Rejected from the "onboarding" review (Manus): a guided wizard and a device-scenario library are real
improvements but large and better suited once the app has real first-time users (i.e. after publishing);
"basic" (token-free) action-card variants for Standard Flow contradict the decision already in SPEC section
7; several "new" high-level Flow cards it proposed already exist (activity_cycle_unusually_long,
device_problem_detected + the scan, group_mismatch_detected/matched_again, now live).

Rejected from the "statistics" review (a second AI pass): a whole new monitor type per idea (duration
anomaly, "stuck state", incomplete cycle, standby monitor, daily cost monitor, phase imbalance monitor) —
cheaper as conditions/triggers on the monitors that already exist, which is what got built here for the two
that were genuinely new (cost, phase imbalance). A completion-time forecast and a MAD-based anomaly score
were declined (same reasoning as the earlier rejection of z-scores on small cycle counts).

### To verify on the Homey (built and unit-tested, not yet seen running)
- **Token tooltips/colors + Copy button** in a "Message wording" form; **calibration progress** on a monitor
  still calibrating (or freshly created with no history).
- **activity_cost_exceeded**: set a price, set two Flows on the same monitor with different amounts, let a
  cycle push past one of them — only that one should fire, once, and re-arm the next day.
- **voltage_phase_imbalance**: two Voltage monitors with a real reading gap.

### Statistics and reliability ideas (review of 2026-09-27), checked against the code

Worth doing, cheap:
- (DONE 2026-09-27) **Floor on the weekly trend baseline.** `weeklyTrend` in `lib/statistics.js` only checks `baseline !== 0`, so a
  previous week with 1 cycle against 3 now reads +200 %. Require a minimum baseline (about 3 cycles, or a
  small amount of energy) and otherwise say "not enough data".
- (DONE 2026-09-27) **P25 / P75 of cycle duration and energy** as extra tokens of `get_activity_statistics` (the cycle list is
  already there), so the spread is visible and not only the median.
- (DONE 2026-09-27; monitors are flagged and stop retrying, never deleted automatically) **Clean up monitors of
  deleted devices** (Activity / State / Voltage kept retrying with `Not Found`). Also a one-line **startup summary** in the log (monitors by kind, group
  subscriptions, scan size) so a pasted log says at once what is running.
- **Real mismatch time for groups**: with live events the time between the transitions can be accumulated
  exactly, instead of the 5-minute poll estimate.
- Already listed above and still valid: **Ignore zone** button, **Generate individual monitors**, widget
  settings editable after adding (Voltage, Overview), erratic cycling and baseline drift triggers.

Later, with care:
- **Optional recalibration** of the activity threshold: today it calibrates once (`calibrating` goes false, and
  also when the user types a threshold). Re-running `analyzeThreshold` every N days would have to apply only a
  clearly different result, and never overwrite a value the user set by hand (needs a `userSetThreshold` flag).
- **Median over a recent window** (14-30 days) as a separate token, to notice a change of behaviour.
- **Show the `analyzeThreshold` result in Settings** (reason, low / high observed) instead of only in the log.
- Duration-weighted average power as an extra token; `energy_quality: partial` when a gap over 4 h falls inside
  the period; a daily average voltage kept in the daily summaries.

Not needed: `activity_cycle_unusually_long` already exists (duration above a multiple of the median), so a "long
cycle" anomaly is done; a statistics library, standard deviation / z-score on few cycles and k-means stay out.

### Housekeeping
- Push the commits and the tags (`git push --follow-tags`): as of 2026-10-02 `main` is 10 commits ahead of
  `origin/main`, and the only local tags are v1.0.1, v1.0.2 and v1.0.4 (no v1.0.5 / v1.0.6 / v1.0.7).
- 1.0.7 is bumped and has a real changelog, but is not published yet (1.0.6 already is). Keep
  `.homeychangelog.json` free of double quotes and apostrophes: the CLI's own commit breaks on them (the 1.0.7
  text had some, removed 2026-10-02).
- The post-commit hook (build stamp) is reinstalled on a fresh clone with `npm run hooks`; GitHub Actions CI
  (`.github/workflows/ci.yml`: tests on Node 22 + `homey app validate`) runs on every push once pushed.
- Ask the Athom forum whether apps will move to Node 24 (no way to select the Node version from the app; v22.23 now).
- (Done, removed from the list: the throwaway `memprobe` app is gone; monitors of a deleted device are now flagged
  `deviceMissing` and stop retrying, see the 2026-09-27 round.)

### Decided against
- Watchdog opt-out by default was replaced by the scan with sane defaults; a device-class adaptive threshold
  (median of report intervals) was judged fragile for sensors that only report on change.
- Statistics library (nothing beyond mean / median / percentile is needed), per-device matrix in Groups,
  "action fires an internal trigger" for Standard Flow (a trigger cannot return values to the calling Flow),
  `cumulative` / energy sign convention (the app exposes no capabilities), the Device Watchdog style virtual
  device with four counters (the widget covers it).

## Settings — Activity/State Monitor missing "Edit" — DONE (2026-09-13)

Both now have an **Edit** action, matching Voltage's. Activity: threshold/continuity/min-
confirmation, via new `updateActivityMonitorSettings()` shared with the `update_activity_monitor`
Flow card. State: true/false labels + `activeValues`, via reusing `_createStateMonitor`'s
existing update-in-place path (no new store method needed). Binary Counter needed nothing —
its only configurable field is the message, already covered by "Message".

## Group per-device breakdown — decided against (2026-09-13), do NOT build

Considered a per-device-per-day matrix inside State Group (`{date, checkCount, perDevice:
{deviceId: seconds}}`) to answer "which door stayed open longest" without needing a State
Monitor per device. Confirmed safe on data volume (day-bound like every dailySummaries[],
capped at 90 rows, nothing like the per-sample growth that caused the earlier memory crash) —
but rejected anyway, on UX/architecture grounds, not a technical one:

- The 5-minute poll (`GROUP_POLL_INTERVAL_MS`) creates a real blind spot — a door open 3
  minutes between two polls would show as "0 seconds" mismatched. A number that's silently
  wrong reads as the app being broken, worse than not showing a number at all. Same failure
  mode already seen this session with the "120 Wh vs 357 W" mislabeled-stat confusion.
- Mixing an approximate poll-based per-device stat into Group blurs the role split the rest of
  the app already keeps clean: State Monitor/Binary Counter = event-driven, exact, per-device;
  State Group = on-demand collective snapshot. Group should stay purely aggregate.

**Instead: add a "Generate individual monitors" button to the Group's Settings row/detail.**
One click calls `_createStateMonitor` once per device in the group — reuses the accurate,
event-driven engine instead of building a parallel approximate one. Capability needs no
prompting: it's already known from the group's own type (`GROUP_TYPES[group.type].capability`
— `alarm_contact`/`onoff`/`garagedoor_closed`). Only needs sensible true/false label defaults
per group type (e.g. contact → "Open"/"Closed"; garage → careful with `GROUP_TYPES.garage`'s
inverted polarity, since a State Monitor's boolean is the raw capability value, not the group's
inverted "expected" framing — label garage's raw `garagedoor_closed` as true="Closed"/
false="Open", not the other way round). Not started.

## Error reporting (@drenso/homey-log / Sentry) — considered, deferred (2026-09-13)

Found while auditing dependencies used by other apps in `_reference/` (specifically
`com.tuya2-main`). Solves a real, already-lived problem: this session's memory/CPU crashes were
only ever caught because someone was watching `homey app run -r`'s live terminal — with the app
actually published, a silent crash would go completely unnoticed. Checked and it's lightweight
(235 KB, 5 files, ISC-licensed — doesn't appear to bundle the full `@sentry/node` SDK, which
alone is 2.7 MB) and not competing with any hypothetical-future-need dependency (unlike
`simple-statistics`/`dayjs`/`p-limit`, this addresses something that has genuinely happened).

Deferred anyway, on the user's own call: it reports to Sentry (sentry.io), a third-party
commercial SaaS (Functional Software, Inc.) — free tier with limits, not self-contained
infrastructure. The library itself is open source (ISC); the destination service isn't. Revisit
once the app is actually published and being used by real people, not just local testing —
that's when unattended-crash visibility starts to matter.

## Virtual device for state groups ("Sentinel Group") - deferred (2026-09-19)

Widgets do not work in the Homey web/PC app, so a native device tile is the only view of a group
that works everywhere. Design settled in conversation, not started:

- Read-only, like the Linked Switch (gpm.linked.switches): dynamic `subdevice_state.N` capabilities
  (`string`, `uiComponent: "sensor"`, `setable: false`), title = member name via `setCapabilityOptions`,
  up to 10 slots + a summary text beyond that; plus `alarm_generic` (mismatch) and a mismatch count.
- Member picker like Lightkeeper's "Choose lights" pair view (`drivers/schedule/pair/lights.html`):
  tabs "Pick devices" / "Use a zone", cards grouped by zone, "include sub-zones", a "N of M support X"
  summary, groups of 1 device allowed, a repair view to edit later. Zones resolve dynamically
  (lightkeeper `DeviceCatalog.devicesInZone` walks descendant zones).
- The device references a `groupId` in the store (pairing creates the group), so the group Flow cards,
  the Settings page and the device share one source; state comes from the existing `_pollGroups`.
- Costs: ~0.6 MB heap per device (Lightkeeper), custom pair-view HTML (styles must be scoped to a root id,
  `homey app validate` cannot check views), 10-slot limit, unavailable-device handling on group delete.
- Prerequisite: the memory work first (this adds fixed memory). Licence: Lightkeeper is MIT, PELS is GPL-3.0.
