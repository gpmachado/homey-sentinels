# Sentinels

Sentinels watches devices you already own and turns their raw capability updates into activity history, cycle counts, energy totals, and plain-language notifications — without ever sending a command back to them. It's read-only by design: no dimming, no switching, no locking, just observation.

- **[HOWTO.md](HOWTO.md)** — usage guide: how to set up each monitor type via Flow cards.
- **[SPEC.md](SPEC.md)** — technical specification: architecture, data model, retention, design decisions.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to run, change and test the app, and the rules that keep it light.
- **[TODO.md](TODO.md)** — what is pending, what still needs checking on a real Homey, and what was decided against.

## What it watches

**Activity monitors** — track a numeric power capability (`measure_power` by default, any `measure_power.*` phase too) and decide ACTIVE/STANDBY by crossing a threshold. Leave the threshold blank and the monitor starts at a working default and auto-calibrates itself from the device's own power history once it has enough samples, instead of asking you to guess a wattage. `continuityMinutes`/`minConfirmationSeconds` smooth out devices with multi-phase duty cycles (a dishwasher's fill/wash/rinse pauses) or noisy readings near the threshold, so one real session doesn't fragment into several.

**State monitors** — mirror a boolean capability (a door, a motion sensor, an on/off switch) directly instead of comparing against a threshold. They also work off a device's own multi-value state (an appliance reporting something like "Running"/"Power Off") by naming which value(s) count as active, matched case- and whitespace-insensitively. If the same device also exposes a power/energy capability, it's tracked automatically alongside the state signal.

**Voltage monitors** — flag under/overvoltage against a min/max range, per capability (so a three-phase meter can be watched phase by phase). Returning to normal waits for the reading to actually settle before closing the episode, so a grid recovering from a sag doesn't produce a burst of flapping notifications.

**Binary counters** — a lightweight tally for instant events (a doorbell press, an alarm trip) driven entirely by your own Flow calling "Log binary event" — no device subscription needed.

**Groups** — a set of same-type devices (doors, lights, switches, valves, garage doors) checked against an expected state. Every member is watched live, so `group_mismatch_detected` fires the moment one changes and `group_matched_again` when it clears; a 5-minute poll stays underneath as a safety net (a device that turned unavailable sends no event) and feeds the daily "time mismatched" estimate. "Check now" and the `check_state_group` card read the devices live on demand.

**Availability** — tells you which devices have stopped talking, in two layers that share the same rules:
- **Watchdogs** (opt-in, per device): its own silence limit, an option for appliances that go unavailable on purpose, Flow triggers `device_became_unavailable` / `device_became_available` / `device_battery_low`.
- **All-devices scan** (on by default): every device without a watchdog is judged with the watchdog defaults — silent longer than the limit (12 h), unavailable, or a low battery (30 %) — so a dead sensor shows up without setting anything up. The Availability tab shows count tiles that filter the list, an amber "Silent N d" badge, and lets you ignore a device, ignore a whole app (virtual devices that only report when used) or give an app its own silence limit (solar panels are quiet all night). New problems are announced once (`device_problem_detected` trigger and a Homey timeline entry); a device that is merely silent is announced only if you turn that on.

Defaults for both layers (silence hours, wait after app start, how long a device must stay unavailable or a battery stay low, battery warning, timeline entries, scan interval) live under Settings → Availability → Watchdog defaults.

## How it talks back

Every monitor exposes Flow triggers, conditions, and actions with tokens for duration, energy, average/peak power and current, and a ready-to-use `message` token — the sentence is built from a template you write once per monitor (with a token-insert helper in Settings), not assembled card-by-card in every Flow. Templates are your own text, in whatever language you like (Homey's own UI has no Portuguese, so nothing is forced through its translations).

Triggers that describe an event also carry the moment it happened: `timestamp` (ISO, UTC — for scripts) and `time` (`2026-09-23 10:14:14`, in your time zone — for a timeline entry or a message; `%time%` works inside message templates too).

## Settings & widgets

The Settings page has three tabs. **Monitors** lists every monitor as a row — name, live state, key stats, a daily sparkline — with actions to edit, reset history or delete. **Availability** shows the scan tiles, the device list with badges, the per-app list and the watchdog defaults. **Groups** lists the groups with a live "Check now", the state Flow currently holds (and a reset for it if it ever gets stuck) and the add/edit form.

Five dashboard widgets (they work in the Homey mobile app and dashboard, not in the web app):

- **Sentinel** — one monitor or group: status, a live session timer, a Today / 7 Days / 30 Days switch, headline numbers and a small chart.
- **Sentinels Overview** — a compact list of up to five picked items, or every monitor and group at once ("Show every monitor", optionally by kind), problems first; with a title.
- **Sentinels Timeline** — the latest events across all monitors.
- **Sentinels Watchdogs** — tiles for not reporting / unavailable / low battery / OK that filter the list, zone names, a **Check now** button, a title and an "only problems" option.
- **Sentinels Voltage** — the current reading of each voltage monitor against its configured band.

Widget settings (title, picked items, filters) can be changed after the widget is added.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```bash
npm test               # unit tests (node:test); CI runs them on Node 22 with `homey app validate`
homey app validate     # builds .homeycompose/ into a valid app.json
homey app run -r       # installs and runs the app on a Homey Pro, streaming its log
npm run hooks          # once per clone: refresh build-info.json after each commit
```

## Known platform limitation

Flow action cards that return tokens (e.g. `get_activity_statistics`, `check_state_group`,
`generate_text_report`) only expose those tokens in Homey's **Advanced Flow** editor — a
limitation of the platform, not this app; there's no token-free variant for the standard editor.
For a Standard Flow, react to a monitor's own trigger cards instead (`activity_started`/
`activity_finished` and their equivalents for the other monitor types) — these already carry
duration, energy, and a ready-to-use `message` token without needing Advanced Flow at all.
