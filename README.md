# Sentinels

A Homey Pro app that observes devices already paired to Homey and turns their raw events
into state, incidents, and statistics — activity cycles, voltage incidents, door/sensor
sessions, event tallies, and multi-device group checks. It never sends a command to any
device; all access is read-only.

- **[HOWTO.md](HOWTO.md)** — usage guide: how to set up each monitor type via Flow cards.
- **[SPEC.md](SPEC.md)** — technical specification: architecture, data model, retention,
  design decisions.

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
