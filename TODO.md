# TODO

## Pending (2026-09-20)

### To verify on the Homey (built and unit-tested, not yet seen running)
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
- Docs are up to date as of 2026-09-23 (README, HOWTO, SPEC, CONTRIBUTING). Translating flow card titles to NL / DE is low priority (Homey has no Portuguese).
- Tests do not cover the Settings HTML, the widgets or real Homey I/O.

### Housekeeping
- Push the commits and the tags (`git push --follow-tags`); the tags `v1.0.1` and `v1.0.2` exist locally only.
- Promote build 1.0.2 in the Homey developer dashboard; write the 1.0.3 changelog for the scan
  (no double quotes or apostrophes in `.homeychangelog.json`: the CLI's own commit breaks on them).
- The post-commit hook (build stamp) is reinstalled on a fresh clone with `npm run hooks`; GitHub Actions CI
  (`.github/workflows/ci.yml`: tests on Node 22 + `homey app validate`) runs on every push once pushed.
- Delete the throwaway probe app `/Users/gabriel/HomeyApp/memprobe` and its dev install on the Homey.
- Ask the Athom forum whether apps will move to Node 24 (no way to select the Node version from the app; v22.23 now).

- Activity / State / Voltage monitors and Availability watchdogs of a device that was deleted keep retrying
  (`Not Found` in the log every few minutes). Watchdogs already flag it for cleanup; monitors do not.

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
