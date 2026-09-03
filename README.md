# Sentinels

Sentinels watches devices you already own and turns their raw capability updates into activity history, cycle counts, energy totals, and plain-language notifications — without ever sending a command back to them. It's read-only by design: no dimming, no switching, no locking, just observation.

- **[HOWTO.md](HOWTO.md)** — usage guide: how to set up each monitor type via Flow cards.
- **[SPEC.md](SPEC.md)** — technical specification: architecture, data model, retention, design decisions.

## What it watches

**Activity monitors** — track a numeric power capability (`measure_power` by default, any `measure_power.*` phase too) and decide ACTIVE/STANDBY by crossing a threshold. Leave the threshold blank and the monitor starts at a working default and auto-calibrates itself from the device's own power history once it has enough samples, instead of asking you to guess a wattage. `continuityMinutes`/`minConfirmationSeconds` smooth out devices with multi-phase duty cycles (a dishwasher's fill/wash/rinse pauses) or noisy readings near the threshold, so one real session doesn't fragment into several.

**State monitors** — mirror a boolean capability (a door, a motion sensor, an on/off switch) directly instead of comparing against a threshold. They also work off a device's own multi-value state (an appliance reporting something like "Running"/"Power Off") by naming which value(s) count as active, matched case- and whitespace-insensitively. If the same device also exposes a power/energy capability, it's tracked automatically alongside the state signal.

**Voltage monitors** — flag under/overvoltage against a min/max range, per capability (so a three-phase meter can be watched phase by phase). Returning to normal waits for the reading to actually settle before closing the episode, so a grid recovering from a sag doesn't produce a burst of flapping notifications.

**Binary counters** — a lightweight tally for instant events (a doorbell press, an alarm trip) driven entirely by your own Flow calling "Log binary event" — no device subscription needed.

**Groups** — check a set of same-type devices (doors, lights, switches, valves, garage doors) against an expected state on demand, and report which ones don't match.

**Availability** — a read-only overview of every Homey device's last-seen time and availability, no configuration required.

## How it talks back

Every monitor exposes Flow triggers, conditions, and actions with tokens for duration, energy, average/peak power and current, and a ready-to-use `message` token — the sentence is built from a template you write once per monitor (with a token-insert helper in Settings), not assembled card-by-card in every Flow.

## Settings & widget

The app's Settings page lists every monitor as a row — name, live state, key stats, a daily sparkline — with actions to edit message wording, reset history, or delete. A single dashboard widget can be pointed at any monitor or group and shows the same at-a-glance summary with a live session timer.

## Development

```bash
npm test              # runs the lib/ unit test suite (node:test)
homey app validate     # validates .homeycompose/ builds into a valid app.json
homey app run           # installs and runs the app on a Homey Pro for live testing
```

## Known platform limitation

Flow action cards that return tokens (e.g. `get_activity_statistics`, `check_state_group`)
only expose those tokens in Homey's **Advanced Flow** editor — a limitation of the platform,
not this app. Each has a `_basic` sibling with no output tokens for use in a standard Flow.
