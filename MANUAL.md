# Sentinels: mini manual

Sentinels 1.0.11 · Homey Pro, firmware 12.4.0 or newer

Sentinels reads the devices you already have in Homey and tells you what they are doing: when a pump runs and for
how long, when a door was left open, when the voltage drops, when a sensor goes quiet.

For every detail, see [HOWTO.md](HOWTO.md). For worked examples with real tokens, see [TUTORIAL.md](TUTORIAL.md).

**Contents:**
[What it is](#what-it-is) ·
[Which monitor](#which-monitor-do-i-need) ·
[First monitor](#your-first-monitor-in-two-minutes) ·
[The five kinds](#the-five-kinds) ·
[Flows](#flows) ·
[Out of the ordinary](#when-something-is-out-of-the-ordinary) ·
[Messages and language](#messages-and-language) ·
[Widgets](#widgets) ·
[Problems](#problems-and-bug-reports) ·
[Upgrading to 1.0.11](#upgrading-to-1011)

## What it is

Sentinels is **read-only**: it never switches anything on or off. It asks for the Homey API permission only because
that is the only way to read devices that belong to other apps.

Everything is set up in the app's **Settings** page. From there the app keeps statistics, fires **Flow triggers**
with ready-made messages, and feeds six **dashboard widgets**. History is kept on the Homey.

## Which monitor do I need?

| You want to know | Use | Example |
|---|---|---|
| When something runs, for how long, how much energy | Activity monitor | Well pump, freezer, washer |
| When something is open, on or detected | State monitor | Door, light, motion sensor, "Running" state of an appliance |
| If the mains voltage leaves a safe range | Voltage monitor | Each phase of an energy meter |
| If several devices are all as expected | Group | All doors and windows closed, all lights off |
| If a device stopped working or its battery is low | Availability | Any device; nothing to set up |

## Your first monitor in two minutes

1. Open **Homey › Apps › Sentinels › Settings** and go to **Monitors › Activity**.
2. Click **Add activity monitor**. Pick the capability (`Power`), then the zone, then the device. Use **Search
   device** if the list is long.
3. Leave **Activity threshold** blank. Sentinels looks at what Homey Insights already logged for that device and
   picks the split between idle and running. The monitor shows *Calibrating* until its own readings confirm it.
4. Save. The row shows the live state, and every finished cycle adds to the statistics.
5. Create a Flow with **Activity finished** and send its `message` token as a notification.

> **WHEN** Activity finished · *Bomba do poço* \
> **THEN** Send notification: `[[message]]`

The message comes ready, for example *Bomba do poço desligou - 50 min, 1,24 kWh (3 hoje)*, in the language you
chose (see [Messages and language](#messages-and-language)).

## The five kinds

- **Activity**: turns a power reading into cycles: duration, energy, average and peak power. Learns its own
  threshold. For a device without a clean power signal, two Flows with **Start monitoring device** and **Stop
  monitoring device** decide when it runs.
- **State**: any on/off or multi-state capability. Give the two states your own words (Open / Closed). Counts
  sessions and time in each state.
- **Voltage**: set a minimum and maximum. A run of bad readings is one incident: one trigger when it starts, one
  with min, max and duration when it ends.
- **Groups**: two or more doors, lights, switches, valves or garage doors with an expected state. Fires the moment
  one member is wrong, and again when all are right.
- **Availability**: checks every device once an hour: not reporting, unavailable, low battery. Add a **watchdog**
  to a device you want its own triggers and limit for.

**Edit** on a monitor can rename it or move it to another device without losing its history. **Reset stats** clears
the numbers and keeps the setup.

## Flows

### One Flow for all of them

Every trigger that asks for a monitor, group or device starts its list with an **Any …** choice: Any activity
monitor, Any state monitor, Any voltage monitor, Any monitor, Any group, Any watched device. Pick it and one Flow
covers all of them, including the ones you add later. The `monitor`, `group` or `device` token says which one it
was.

> **WHEN** State session started · *Any state monitor* \
> **THEN** Send notification: `[[message]]` at `[[time]]`

### Tokens worth knowing

- `message`: the ready sentence, in your language.
- `time`: local time, for people. `timestamp`: ISO in UTC, for scripts.
- `duration_human`: "1 h 3 min". `duration`: the same in seconds.

### Cards that return numbers need Advanced Flow

Get activity statistics, Get state statistics, Get voltage statistics, Get usage pattern, Get group statistics,
Check state group, Generate text report, Get standby ranking, Get daily digest and Export data as JSON only show in
the **Advanced Flow** editor. Homey hides action cards with tokens from the standard editor.

> **WHEN** Every Sunday at 20:00 \
> **THEN** Generate text report · *Bomba do poço* · last 7 days \
> **THEN** Send notification: `[[report]]`

Result: *Bomba do poço (últimos 7 dias): ciclos 16, energia 22,29 kWh, ligado 14 h 36 min.*

## When something is out of the ordinary

Statistics update with every reading. These cards compare what is happening now with the monitor's own history,
so you are told about the unusual and not about every event.

| Out of the ordinary | Card | Tells you |
|---|---|---|
| Running much longer than usual | Trigger **Still running long** (N × its usual cycle) | While it is still running |
| A cycle that was too long | Trigger **Cycle unusually long** | When the cycle ends |
| Too many times today | Trigger **Cycle count reached** | On the Nth cycle |
| Running at an unusual hour | Condition **usually does not start in this hour**, under Activity started | When it starts |
| Has not run for too long | Condition **has not been active for at least N hours** | When a timed Flow checks |
| A sensor stopped sending values | Condition **Has a reading in the last minutes** | When a timed Flow checks |
| Voltage out of range | Triggers **Undervoltage** / **Overvoltage detected** | At once |
| A door left open, a light left on | Trigger **Group mismatch detected** | At once |
| A device dead or its battery low | **A device needs attention**, or a watchdog's triggers | At the next scan |

> **WHEN** *Bomba do poço* is still running after **2**× its usual duration \
> **THEN** Send notification: `[[monitor]]` running for `[[duration_human]]`, usually `[[median_duration_human]]`

The cards that compare with "usual" need a few finished cycles first: 5 for the median duration, 20 for the usual
hours.

## Messages and language

Each monitor and group has its own message templates, set under **Messages** in Settings. Tap a token button to
insert `%monitor%`, `%duration_human%`, `%energy%` and so on. **Fill default wording** writes the ready-made sentences
back.

**Default message language** (Settings › Monitors) sets the language of those ready-made sentences and of the texts
the app writes itself: reports, the daily digest, the weekly trend, weekday names. Choices: Dansk, Deutsch, English,
Español, Français, Italiano, Nederlands, Norsk, Português and Svenska.

**About Portuguese.** Homey itself is not available in Portuguese, so the Flow cards and the Settings page are in
English. The author is Brazilian, so Portuguese (Brazil) was added for what the app writes: the messages and the text
tokens. Choose *Português* and notifications and speech come out in Portuguese whatever language Homey is set to.

- `%count:vez|vezes%` writes the first word when the count is 1 and the second otherwise.
- Tick **Use a comma as the decimal separator** for "1,5 kWh". Number tokens keep the dot.
- A message you wrote is never replaced when you change the language.

## Widgets

Widgets work on the Homey mobile app and dashboards, not in the web app.

| Widget | Shows |
|---|---|
| Sentinel | One monitor or group: status, today / 7 / 30 days, a small daily chart |
| Overview | Several monitors as a compact list, problems first |
| Timeline | The latest events of every monitor |
| Health | Devices, running now, voltage and groups, each with a light |
| Watchdogs | Not reporting, unavailable, low battery, with Check now |
| Voltage | Each phase against its band |

## Problems and bug reports

- **A trigger never fires.** Check that the card's monitor is the right one, or pick **Any …**. Cards that compare
  with "usual" stay quiet until the monitor has enough cycles.
- **A group shows a mismatch but the trigger did not fire.** In Settings › Groups, the row says what Flow was last
  told. **Reset Flow status** makes the next change fire again.
- **Calibrating for a long time.** The device needs both idle and running readings. Type a threshold to end it.
- **Device missing badge.** The device was deleted from Homey. The monitor and its history stay until you delete it.

To report a problem: turn on **Detailed log** in Settings, repeat what went wrong, and post in the forum topic or
open a [GitHub issue](https://github.com/gpmachado/homey-sentinels/issues) with the app version, what you did and
what you expected.

## Upgrading to 1.0.11

**Some Flows need editing.** Six cards were merged or removed. A Flow that used one shows it as broken; replace it as
below.

| Old card | Use instead |
|---|---|
| [monitor] is active · [monitor] is true | Monitor is active |
| Reset activity / state / voltage monitor statistics | Reset monitor statistics |
| [monitor] is within range | [monitor] is in state › Normal |

---

Test version: <https://homey.app/a/com.gpm.sentinels/test/>
