# TODO

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
