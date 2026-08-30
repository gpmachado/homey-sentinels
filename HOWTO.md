# Sentinels — Usage Guide

Sentinels observes devices you've already paired to Homey and turns their raw events into
state, incidents, and statistics. It never sends a command to a device — everything here is
read-only. There's nothing to configure at install time; every monitor is created through a
Flow card, and managed afterwards from the app's Settings page.

## Which one do I need?

Five independent ways to watch something. Answer these in order — the first one that fits is
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

## 1. Activity Monitor — power-based devices

For anything with a meaningful, clean power draw when running: a fridge, a freezer, an oven.
machine.

1. Add a Flow with the action card **"Add activity monitor"**.
   - **Device**: pick the physical device.
   - **Capability**: leave blank to use `measure_power` — Sentinels auto-detects and tracks
     related capabilities (current, energy, voltage) on the same device, no need to add them.
   - **Activity threshold (W)**: the wattage above which the device counts as active. For a
     pump this might be 50W; for a fridge compressor, 20W.
   - **Continuity window** / **minimum confirmation**: leave at 0 unless the device's power
     dips briefly between phases (a washer) or the reading is noisy — see the card's own hint
     for what each one does.
   - Run this Flow once (e.g. on "Homey started", or manually) to create the monitor.
2. Build Flows off **"Activity started"** / **"Activity finished"** — pick the monitor in the
   card's dropdown (required, so you always know which one you're reacting to). "Finished"
   carries duration, energy, and average/peak power/current as tokens.
3. Use **"Get activity statistics"** for a period (today/7 days/30 days/all) wherever you need
   the numbers without waiting for a trigger — cycle count, durations, energy, median cycle
   duration, and a week-over-week trend.
4. Message wording for both triggers is written **once, in Settings** (Monitors tab → Activity
   sub-tab → "Edit messages"), same token-insert pattern as Voltage Monitor below. The
   "finished" message gets a `%count%` token — today's cycle count, already including the one
   that just finished — so "pump turned off %count% %count:time|times% today" needs no
   separate counter Flow.

**No reliable power/standby signal?** A pure on/off pump or switch might never show a clean
threshold crossing — a microwave or freezer usually does (clear standby vs. running draw), so
they stay on the regular threshold flow above; a pump often doesn't. For those, skip "Add
activity monitor" and use **"Start monitor [[monitor]]"** / **"Stop monitor [[monitor]]"**
(for a monitor you already created) or, in one step, **"Start monitoring device"** /
**"Stop monitoring device"** (creates the monitor for that device on first run if it doesn't
exist yet) — either way, driven by whatever Flow logic you already trust, typically a native
"Power becomes greater than X" / "Power becomes less than X" trigger pair. The resulting
monitor never decides active/standby from its own power reading; only these cards do — it
still tracks power/current/energy the whole time, so "Stop" still reports full duration/energy
tokens, same as a regular finished cycle.

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
4. Message wording (Settings → Monitors → State sub-tab → "Edit messages") works the same way
   as Activity Monitor's — use `%label%` for the state just entered, `%count%` (on "finished")
   for today's session count.

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
   card) — give it a name, a type (contact/light/switch/valve), and pick which devices belong
   to it (at least two, all compatible with the chosen type).
2. Use **"Check state group"** in a Flow whenever you want the live result — it reads every
   device in the group right then, there's no background subscription or history. Tokens:
   matched/mismatch counts and a rendered message (edit the wording per match-count in the
   group's own settings, same token-insert pattern as above).
3. Condition **"[Group] has a mismatch"** works directly in a Flow's `AND`/`OR` — no separate
   "all match" card exists, since Homey's own condition-card negation toggle already covers
   that case.

**Known limitation**: a group has no memory — it can't tell you "how many times did any door
open today," only "are they all in the expected state right now."

## The Settings page

Open the app's Settings from Homey. Three tabs:

- **Monitors** — sub-tabs for Activity / State / Voltage / Binary, each with its own table
  (state, stats, a small trend sparkline) and Reset stats / Delete buttons per row. A shared
  Today/7 Days/30 Days period selector applies across all four.
- **Availability** — every Homey device, last seen and current availability, no configuration
  needed.
- **Groups** — existing groups (with a "Check now" button for a live status check) and the
  Add/Edit form.

**Reset stats** wipes cycles/history/live state while keeping the monitor's own configuration
(device, capability, threshold, settings) — for when the data itself was wrong (e.g. a
misconfigured capability recorded garbage before being fixed). **Delete** removes the monitor
entirely.

## The widget

Add the "Sentinela" widget to a Homey dashboard, then pick a monitor or group in its settings
(search by name). It shows current status, a Today/7 Days/30 Days period switch, the relevant
headline numbers for that monitor type, and — for Activity/State monitors — a small daily
chart. A group widget shows live matched/mismatch counts and the rendered message.

## Common pitfalls, all in one place

- **Power vs Voltage capability** on a multi-phase device — the capability pickers for
  Activity and Voltage monitors filter to the right kind, but double-check the exact phase.
- **Binary Counter's name field is an identity, not a label** — don't insert a live device tag
  there.
- **Token-returning cards need Advanced Flow** — `get_activity_statistics`,
  `get_voltage_statistics`, `get_binary_event_statistics`, `get_state_statistics`, and
  `check_state_group` only expose their tokens in the Advanced Flow editor. Each has a
  `_basic` version (no tokens) that also works in a standard Flow.
