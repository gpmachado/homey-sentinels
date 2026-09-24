# Sentinels — Usage Guide

Sentinels observes devices you've already paired to Homey and turns their raw events into
state, incidents, and statistics. It never sends a command to a device — everything here is
read-only. There's nothing to configure at install time; monitors are created through a
Flow card or the Settings page, and managed from there afterwards. The availability scan starts on its own.

## Which one do I need?

Seven independent ways to watch something. Answer these in order — the first one that fits is
the one to use:

1. **Is it a boolean sensor** — a door/window contact, a motion sensor, anything that's simply
   true/false? → **State Monitor**.
2. **Do you just want to count how many times something happened**, with no duration to
   track (a doorbell press, a button click)? → **Binary Counter**.
3. **Are you comparing several devices of the same kind** — are all the doors closed, are all
   the lights off? → **State Group**.
4. **Is it a device that's on all the time**, cycling on its own with no single moment where a
   person "turns it on" — a freezer, a fridge? → **Activity Monitor**, set up once with **"Add
   activity monitor"**. One card, done — the compressor's own power cycling drives everything
   automatically.
5. **Is it a device with a distinct "on" moment, but the power reading during that on-time
   isn't clean enough to trust on its own** — no indicator light, draws nothing while idle, or
   you'd just rather decide "on" from something else you already trust (a native trigger, a
   button)? → **Activity Monitor, driven manually**: one Flow with **"Start monitoring
   device"** wired to whatever tells you it started, a second Flow with **"Stop monitoring
   device"** wired to whatever tells you it stopped. Two Flows instead of one card, in
   exchange for you deciding exactly what "on" means instead of a threshold guessing it.
6. **Is it about voltage staying in range**, not power/duration? → **Voltage Monitor**.
7. **Do you just want to know if a device stops working entirely** — not its activity, just
   whether it's still there and reporting? → **Availability**. Nothing to set up: the scan already
   checks every device; add a **watchdog** only to one you want a Flow for, with its own limit.

## 1. Activity Monitor — power-based devices

For anything with a meaningful, clean power draw when running: a fridge, a freezer, an oven.
machine.

1. Add a Flow with the action card **"Add activity monitor"**.
   - **Device**: pick the physical device.
   - **Capability**: leave blank to use `measure_power` — Sentinels auto-detects and tracks
     related capabilities (current, energy, voltage) on the same device, no need to add them.
   - **Activity threshold (W)**: the wattage above which the device counts as active. For a
     pump this might be 50W; for a fridge compressor, 20W.
   - Run this Flow once (e.g. on "Homey started", or manually) to create the monitor. It starts
     with no continuity/confirmation delay — if you later notice a device's power dips briefly
     between phases (a washer) and fragments into multiple cycles, or a noisy reading creates
     false starts, use **"Update activity monitor"** to add a continuity window or minimum
     confirmation without recreating the monitor.
2. Build Flows off **"Activity started"** / **"Activity finished"** — pick the monitor in the
   card's dropdown (required, so you always know which one you're reacting to). "Finished"
   carries duration, energy, and average/peak power/current as tokens.
3. Use **"Get activity statistics"** for a period (today/7 days/30 days/all) wherever you need
   the numbers without waiting for a trigger — cycle count, durations, energy, median cycle
   duration, and a week-over-week trend.
4. Message wording works out of the box — a new monitor already has a sensible default
   (`"%monitor% turned on (%power% W)"` / `"%monitor% turned off — %duration_human%, %energy%
   kWh (%count% today)"`), edit it if you want something different in Settings (Monitors tab →
   Activity sub-tab → "Edit messages"), same token-insert pattern as Voltage Monitor below. The
   "finished" message's `%count%` is today's cycle count, already including the one that just
   finished.

**No reliable power/standby signal?** A pure on/off pump or switch might never show a clean
threshold crossing — a microwave or freezer usually does (clear standby vs. running draw), so
they stay on the regular threshold flow above; a pump often doesn't. For those, skip "Add
activity monitor" entirely and use **"Start monitoring device"** / **"Stop monitoring device"**
instead — no separate creation step, the first "Start" run creates the monitor for that device
if it doesn't exist yet. Driven by whatever Flow logic you already trust, typically a native
"Power becomes greater than X" / "Power becomes less than X" trigger pair. The resulting
monitor never decides active/standby from its own power reading; only these two cards do — it
still tracks power/current/energy the whole time, so "Stop" still reports full duration/energy
tokens, same as a regular finished cycle. Both cards carry their own tokens (`message`, `power`
on Start; `duration`, `energy`, `average_power`/`max_power`, `average_current`/`max_current`,
`message` on Stop) usable right in the same Flow, in Advanced Flow mode — no separate Flow
listening on "Activity started"/"Activity finished" required.

**Gotcha**: the threshold is in Watts. If the capability picker shows something like "Power
Phase A" next to "Voltage Phase A" on a 3-phase device, make sure you picked the Watt one —
this card is not for voltage (see the Voltage Monitor section).

## 2. State Monitor — doors, motion, on/off sensors

For a boolean capability with no meaningful wattage: a door/window sensor, a presence sensor,
a plain on/off switch you don't have power data for.

1. Add a Flow with **"Add state monitor"**.
   - **Device** / **Capability**: the picker only shows boolean capabilities on that device
     (contact, motion, on/off).
   - **Label when true** / **Label when false**: name the two states in your own words — e.g.
     "Open"/"Closed" for a door, "Detected"/"Clear" for a motion sensor. There's no "which one
     is active" choice to get backwards: both directions are tracked and reported side by
     side, the labels are purely for readability. If you leave them blank they default to
     "True"/"False".
2. **"State session started"** / **"State session finished"** fire on every transition into/out
   of the raw `true` value — each carries a `label` token (the state it just entered) plus
   duration on "finished". They work the same way as Activity Monitor's triggers, minus
   power/energy tokens (they don't apply here).
3. **"Get state statistics"** gives you session count, time spent as true *and* as false
   (`true_duration`/`false_duration`, plus their labels as tokens), median session duration,
   and the weekly trend.
4. Message wording defaults to `"%monitor% is now %label%"` / `"%monitor% is now %label%
   (%count% today)"` — works out of the box, editable in Settings → Monitors → State sub-tab →
   "Edit messages", same idea as Activity Monitor's.

## 3. Voltage Monitor — over/undervoltage on a phase

1. Add a Flow with **"Add voltage monitor"**.
   - **Capability**: the picker only shows `measure_voltage*` capabilities — if your device is
     3-phase, make sure you pick the phase you actually mean (e.g. "Voltage Phase A", not
     "Power Phase A").
   - **Min voltage** / **Max voltage**: the safe range.
   - **Stabilization window**: suppresses events for the first few minutes after creation, so
     an initial noisy reading doesn't fire a false alarm before the monitor has settled.
2. A continuous excursion outside the range is **one incident**, not one event per bad
   reading — you get a single "Undervoltage detected"/"Overvoltage detected" trigger when it
   starts, and "Voltage returned to normal" (with the whole episode's min/max/average voltage
   and duration) when it ends.
3. Message wording for each of the three triggers is written **once, in Settings** (Monitors
   tab → Voltage sub-tab → "Edit messages" on the monitor), not as a Flow card argument — so
   you don't have to rebuild the sentence in every Flow. Tap a token button to insert it into
   whichever message field you last clicked.

## 4. Binary Counter — tally an occurrence, no duration

For a fire-and-forget event: a doorbell press, a single motion pulse, a button click.

1. Add a Flow with **"Add binary counter"**.
   - **Counter name**: type a name. This field offers existing counters as you type (pick one
     to update it) or a "Create new" option if it doesn't match anything — it's an identity
     field, matched by exact text every time this card runs, so don't insert a live device tag
     here (that would create a new counter on every run instead of updating the same one).
2. Wherever the real occurrence happens (a doorbell's own trigger, a motion sensor firing),
   add **"Log binary event"**, pick the counter — it bumps the count and renders the message
   configured for it in Settings.
3. Message wording (Settings → Monitors → Binary sub-tab → "Edit message") uses `%counter%`,
   `%count%`, `%total%`, and `%count:singular|plural%` — the last one automatically picks the
   first word when the count is exactly 1, the second otherwise (e.g.
   `%count:time|times%` → "1 time" / "3 times").

## 5. State Group — check several devices at once

For "are all the doors closed", "are all the lights off" — any check across two or more
devices of the same logical type.

1. In Settings → Groups tab, click **Add group** (or use the **"Create state group"** Flow
   card) — give it a name, a type (contact/light/switch/valve/garage door), and pick which devices belong
   to it (at least two, all compatible with the chosen type).
2. Use **"Check state group"** in a Flow whenever you want the live result — it reads every
   device in the group right then. Tokens: matched/mismatch counts and a rendered message (edit
   the wording per match-count in the group's own settings, same token-insert pattern as above).
3. Condition **"[Group] has a mismatch"** works directly in a Flow's `AND`/`OR` — no separate
   "all match" card exists, since Homey's own condition-card negation toggle already covers
   that case.
4. Triggers **"Group mismatch detected"** / **"Group matched again"** fire on their own, the
   moment a member device changes: every member is watched live, so a door opening fires the
   trigger at once, and closing it fires "matched again". "Detected" fires once per mismatch, not
   again while it stays that way. A 5-minute check underneath catches what an event cannot (a
   member that turned unavailable) and keeps the daily "time mismatched" estimate.
5. A group is judged only once every member has reported a value; right after the app starts,
   the first check settles that.

**If a device of the group is deleted from Homey**: the group keeps working with the others (the deleted
one is not counted as a mismatch). After it has been missing for three checks in a row (about 15 minutes) it
is removed from the group on its own and a line is added to the event log. To do it right away, use
**Clean up** on the group's row in Settings → Groups (it appears when a member is no longer in Homey), or
open **Edit**: the deleted members are listed in red under the device list, with **Remove now**. Saving the
form also drops them. A group left with fewer than two devices is kept but no longer checked: add a device
or delete it.

**If the trigger never fires although "Check now" shows a mismatch**: in Settings → Groups the
row says whether Flow thinks a mismatch was already reported ("Flow: mismatch reported since
..."). If it is stuck there, press **Reset Flow status**; the next change fires the trigger again.
"Check now" and the "Check state group" card never touch that state, which is why they can show a
mismatch the trigger did not report.

**Known limitation**: a group has no per-device history — it can't tell you "how many times did
any door open today," only "is it currently mismatched, and for how long today's checks have
seen it mismatched" (an estimate). For exact per-device numbers, add a State Monitor to those
devices.

## 6. Availability — find the devices that stopped talking

For any Homey device — not a Sentinels monitor, just a plain device. There are two layers with the
same rules.

**The all-devices scan (on by default).** Every device without a watchdog is checked with the
defaults, about two minutes after the app starts and then once an hour:

- **Not reporting** — silent for longer than the limit (12 h by default; a device Homey has never
  heard from is not called silent),
- **Unavailable** — the driver's own `available` flag is false (optionally only after staying so for
  a number of seconds),
- **Low battery** — `measure_battery` at or below the warning percent (30 by default).

Settings → Availability shows a tile for each, and tapping a tile filters the list. **Scan now**
runs it right away. Each row has an amber **Silent N d** badge when a device says `available` but
has gone quiet — battery sensors never flip that flag when they die. Per device you can **Ignore**
it. The **Apps** list lets you tick whole apps that the scan should not monitor (virtual devices that
only report when used, such as a light switched by a Flow) and give an app its **own silence limit in
hours** — solar panels are silent all night, so 36 h there keeps a real failure visible without a daily
false alarm.

New problems are announced **once**: the trigger **"A device needs attention"** (tokens: device, zone,
last seen, reason `stale`/`unavailable`/`low_battery`, battery; at most 10 per scan) and one entry in
the Homey timeline. The very first scan only records what is already wrong. A device that is merely
**silent** is not announced unless you tick "Also announce devices that are only silent" in Watchdog
defaults — a switch that only reports when pressed is silent all day.

**Watchdogs (opt-in, per device)** — for a device you care about more, with its own limit:

1. In Settings → Availability, click **Add watchdog** next to a device (or use the **"Add
   availability watchdog"** Flow card) and set how many hours it may go without reporting. Tick
   *Ignore the "unavailable" status* for an appliance that goes unavailable on purpose (a washer that
   a cloud app marks offline when switched off): then only silence counts.
2. It fires **"Device became unavailable"** (token `reason`: `unavailable` or `stale`) and, on
   recovery, **"Device became available"** (with a `downtime` token). **"Watched device battery is
   low"** fires when its battery drops to the warning level.
3. Condition **"[Device] is available"** checks the raw flag directly, no watchdog required — a quick
   guard, accurate only for well-behaved drivers.
4. A watchdog whose device is no longer in Homey is flagged after a few checks, and Settings offers to
   remove it.

**Watchdog defaults** (Settings → Availability → Watchdog defaults): hours without reporting for new
watchdogs and for the scan, minutes to wait after the app starts, seconds a device must stay
unavailable and a battery stay low before it counts, the battery warning (0 turns it off), Homey timeline
entries, whether to scan everything and how often.

**Widget**: "Sentinels Watchdogs" shows the same tiles on a dashboard, with a **Check now** button.

## The Settings page

Open the app's Settings from Homey. Three tabs:

- **Monitors** — sub-tabs for Activity / State / Voltage / Binary, each with its own table
  (state, stats, a small trend sparkline) and Edit / Reset stats / Delete buttons per row. A shared
  Today/7 Days/30 Days period selector applies across all four.
- **Availability** — the scan tiles and **Scan now**, **Watchdog defaults**, the **Apps** list, and every
  Homey device with its badge, last seen and its Add/Edit/Remove watchdog and Ignore actions.
- **Groups** — existing groups (with a "Check now" for a live status, the state Flow holds and a
  reset for it) and the Add/Edit form.

**Reset stats** wipes cycles/history/live state while keeping the monitor's own configuration
(device, capability, threshold, settings) — for when the data itself was wrong (e.g. a
misconfigured capability recorded garbage before being fixed). **Delete** removes the monitor
entirely.

## The widgets

Widgets show on the Homey mobile app and dashboards; they do not work in the web app. All of them
refresh every 30 seconds while on screen, and their settings can be changed after adding them.

- **Sentinel** — pick one monitor or group in its settings (search by name). Shows current status, a
  Today/7 Days/30 Days switch, the headline numbers for that type and a small daily chart. A group
  always shows live matched/mismatch counts and the rendered message; 7 Days/30 Days add how much of
  the period it spent mismatched.
- **Sentinels Overview** — up to five picked items as one compact list, or **Show every monitor**
  (optionally only one kind), problems first, with an optional title.
- **Sentinels Timeline** — the latest events across all monitors.
- **Sentinels Watchdogs** — tiles for not reporting / unavailable / low battery / OK that filter the
  list, the zone of each device, a **Check now** button, an optional title and "only devices with a
  problem".
- **Sentinels Voltage** — each voltage monitor's current reading against its configured band.

## Common pitfalls, all in one place

- **Power vs Voltage capability** on a multi-phase device — the capability pickers for
  Activity and Voltage monitors filter to the right kind, but double-check the exact phase.
- **Binary Counter's name field is an identity, not a label** — don't insert a live device tag
  there.
- **Token-returning cards need Advanced Flow** — `get_activity_statistics`,
  `get_voltage_statistics`, `get_binary_event_statistics`, `get_state_statistics`,
  `get_group_statistics`, `check_state_group`, `generate_text_report`, `export_data`,
  `log_binary_event`, `start_monitoring_device`, and `stop_monitoring_device` only appear as
  selectable cards in the Advanced Flow editor; Homey hides any action card with output tokens
  from the standard editor entirely. There's no token-free variant — react to a monitor's own
  trigger cards in a Standard Flow instead, they already carry a ready-to-use `message` token.
- **`timestamp` is UTC, `time` is local.** Triggers with a moment carry both: `timestamp` is an ISO
  string in UTC (`2026-09-23T13:14:14.591Z`, for scripts), `time` is `2026-09-23 10:14:14` in your time
  zone. Use `time` (or `%time%` in a template) for a person; the Homey timeline already shows when each
  entry was made, so the `message` alone is usually enough there.
- **"Check now" and the trigger can disagree** for a group — see State Group above (Reset Flow status).
- **A device with `last seen never`** is not treated as silent; there is no date to compare.
