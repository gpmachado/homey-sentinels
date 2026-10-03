# Sentinels — Tutorial: worked examples and the tokens you get back

[HOWTO.md](HOWTO.md) says which card to use for what. This file shows **what actually comes out**: for each
kind of monitor, a small example, the Flow to build, and the tokens and messages you should see. The numbers
were produced by running the app's own engine and message code on the sample readings described in each
example, so they are what a real device with those readings gives; yours will differ in the details.

Names used below (all invented): a well pump **"Bomba do poço"** on an energy meter, a door sensor
**"Porta da frente"**, a three-phase meter with a monitor per phase (**"Voltagem Fase A"**), a group
**"Portas e janelas"**. Prices are in R$ with a price of 0.85 per kWh.

## 0. Reading tokens: four rules

1. **Where a token shows up.** A *trigger* card (Activity finished, Group mismatch detected, ...) hands its
   tokens to every card after it in the Flow. An *action* card that returns tokens (Get activity statistics,
   Check state group, ...) only shows them in Homey's **Advanced Flow** editor — a platform limit. The
   `message` token on a trigger is the sentence already built from the monitor's template (Settings →
   Monitors → Edit messages); use it when you do not want to rebuild the sentence in every Flow.
2. **Numbers are rounded to three decimals** when they leave the app (`3.92`, not `3.9199999999999997`). Whole
   numbers are left alone. The same rounding is used inside messages, so a token and the same value in a
   message always agree.
3. **`timestamp` is UTC, `time` is local.** `timestamp` is an ISO string for scripts
   (`2026-10-03T14:02:00.000Z`); `time` is the same moment in your time zone and readable
   (`2026-10-03 11:02:00`). Use `time` in a Timeline entry. A few triggers (Activity finished, Voltage returned to normal) carry only `time`.
4. **No data is 0 or empty, never missing.** Homey rejects an empty number token, so a number with no value
   is `0` and a text token is an empty string. Cost tokens are `0` / empty until a price is set. Inside a
   message template, a placeholder with no value (for example `%power%` on a voltage monitor whose device has
   no power capability) renders as nothing.

## 1. A pump: Activity Monitor

**Set up.** A Flow with **Add activity monitor** (device: the energy meter, threshold 50 W — or leave it blank
and let it calibrate), run once. Then two Flows: **Activity started** → *Create a Timeline notification*
with the `Message` token, and **Activity finished** → another one.

**Sample run.** The meter reads 3 W (idle), then 1480 W for 38 minutes while its energy counter climbs by
about 0.96 kWh, then 3 W again.

**Activity started** — tokens, at the moment power crosses the threshold:

| Token | Value | Notes |
|---|---|---|
| `device` | `Poço Energy Meter` | the device's own name |
| `monitor` | `Bomba do poço` | the monitor's name |
| `power` | `1480` | W at that reading |
| `timestamp` | `2026-10-03T14:02:00.000Z` | UTC, for scripts |
| `time` | `2026-10-03 11:02:00` | local, for people |
| `message` | `Bomba do poço turned on (1480 W)` | default template |

**Activity finished** — tokens, when it drops back under the threshold:

| Token | Value | Notes |
|---|---|---|
| `duration` | `2280` | seconds |
| `duration_human` | `38 min` | |
| `energy` | `0.96` | kWh of this cycle, always kWh (a small cycle shows `0.07`, not `70 Wh`) |
| `energy_today` | `0.96` | kWh of today, **including** this cycle |
| `count` | `1` | cycles today, including this one |
| `average_power` / `max_power` | `1480` / `1480` | W while active |
| `average_current` / `max_current` | `0` / `0` | A; `0` when the device reports no current |
| `cost` / `cost_today` | `0.82` / `0.82` | `0` until a price is set (see section 2) |
| `cost_text` / `cost_today_text` | `R$ 0.82` / `R$ 0.82` | empty until a price is set |
| `time` | `2026-10-03 11:40:00` | local |
| `message` | `Bomba do poço turned off - 38 min, 0.96 kWh (1 today)` | default template |

**Your own wording.** Settings → Monitors → Activity → *Edit messages*; tap a token button to insert it.
`%count:vez|vezes%` picks the first word when the count is exactly 1:

```
%monitor% desligou - %duration_human%, %energy% kWh, R$ %cost% (%count% %count:vez|vezes% hoje)
→ Bomba do poço desligou - 38 min, 0.96 kWh, R$ 0.82 (1 vez hoje)
```

**Building the sentence in the Flow instead** (what the Timeline entry in the example Flow does): a
notification text of `[Message] [Cycles today] vezes hoje. [Duration] consumo [Energy today (kWh)]` gives

```
Bomba do poço turned off - 38 min, 0.96 kWh (1 today) 1 vezes hoje. 38 min consumo 0.96
```

The last number is `0.96` and not a long string of decimals because of the rounding rule above.

## 2. Cost

**Set up.** Settings → Monitors → *Energy cost*: price per kWh `0.85` and currency `R$`. Or change it from a
Flow with **Set energy price** (for a time-of-use tariff: at 18:00 set `1.20`, at 21:00 set `0.60`). A cycle
is priced at the price in force when it **ends**.

Two cycles on the same day: 0.96 kWh (38 min), then 1.21 kWh (47 min).

| After | `energy` | `cost` | `energy_today` | `cost_today` |
|---|---|---|---|---|
| cycle 1 | `0.96` | `0.82` | `0.96` | `0.82` |
| cycle 2 | `1.21` | `1.03` | `2.17` | `1.84` |

`cost_today` is priced from today's **total energy** (2.17 × 0.85 = 1.84) and rounded once, so it can differ
by a cent from adding the two `cost` values (0.82 + 1.03 = 1.85). That is intended.

**Cost today exceeds an amount.** Fires once per day, on the cycle that carries today's cost to or past the
amount, and starts over at midnight. The amount must be at least `0.01`.

| Flow's amount | Fires on | Why |
|---|---|---|
| `0.50` | cycle 1 | today went from 0 to 0.82 |
| `1.00` | cycle 2 | today went from 0.82 to 1.84 |
| `2.00` | not yet | today is still 1.84 |

A third cycle that takes today past 2.00 fires the `2.00` Flow, and the other two do not fire again.
Its tokens: `device`, `monitor`, `cost_today` (`1.84`), `cost_today_text` (`R$ 1.84`), `time`, `message`.

## 3. Statistics: Get activity statistics

**Set up.** An Advanced Flow with **Get activity statistics** (monitor, period `today`) — for example on a
Timeline trigger at 22:00. Six cycles of 38, 47, 41, 52, 44 and 39 minutes with about 1 kWh each:

| Token | Value | Notes |
|---|---|---|
| `cycle_count` | `6` | |
| `active_duration` | `16020` | seconds active (4 h 27 min) |
| `total_energy` | `6.577` | kWh |
| `total_cost` / `total_cost_text` | `5.59` / `R$ 5.59` | with a price set |
| `average_power` / `max_power` | `1480` / `1480` | W while active |
| `median_duration` | `2610` | seconds |
| `median_duration_human` | `44 min` | the median of an even count is the middle pair's average (43.5 min) |
| `p25_duration_human` / `p75_duration_human` | `41 min` / `47 min` | the spread around the median |
| `median_energy` / `p25_energy` / `p75_energy` | `1.071` / `0.995` / `1.165` | kWh per cycle |
| `trend_summary` | `This week vs. previous: activity no prior baseline, cycles no prior baseline, energy no prior baseline.` | |

The median and percentiles need at least **5 cycles**, otherwise they are `0` / empty. The week-over-week
trend needs at least **3 cycles in the previous week**; until then it says "no prior baseline" instead of a
misleading `+200 %`. A period with no cycles gives `0` for every number.

## 4. A door: State Monitor

**Set up.** **Add state monitor** (device: the door sensor, labels `Open` / `Closed`). Both directions are
tracked; the labels are only for reading.

| Moment | Card | Tokens |
|---|---|---|
| door opens | **State session started** | `label` = `Open`, `time`, `timestamp`, `message` = `Porta da frente is now Open` |
| door closes 12 minutes later | **State session finished** | `label` = `Closed`, `duration` = `720`, `duration_human` = `12 min`, `count` = `1`, `message` = `Porta da frente is now Closed (1 today)` |

If the sensor's device also reports power or energy, those tokens are filled in too; otherwise they are `0`.
**Get state statistics** gives `cycle_count`, `true_duration` / `false_duration` (seconds), their labels,
the median and percentiles and the trend, with the same rules as section 3.

## 5. Voltage: one monitor per phase

**Set up.** **Add voltage monitor** (device: the meter, capability `Voltage Phase A`, range `210`–`240` V).

**Sample readings.** 229.8, 228.1 (normal), then 204.3 and 206.9 (low), then back to 228.4 and 229.0.

| Moment | Card | Tokens |
|---|---|---|
| first reading under 210 | **Undervoltage detected** | `voltage` = `204.3`, `time`, `timestamp`, `message` = `Voltagem Fase A is in undervoltage - 204.3 V.` |
| reading back in range, once it holds | **Voltage returned to normal** | `event_type` = `UNDERVOLTAGE`, `duration` = `300`, `duration_human` = `5 min`, `voltage` = `228.4`, `min_voltage` = `204.3`, `max_voltage` = `206.9`, `average_voltage` = `205.6`, `time`, `message` = `Voltagem Fase A normalized after 5 min (min 204.3 V, max 206.9 V).` |

A long excursion is **one** incident: one "detected" when it starts and one "returned to normal" when it
ends, with the whole episode's range. In "returned to normal", `min_voltage` / `max_voltage` / `average_voltage`
describe the **episode** (the bad readings), not the readings around it. Returning to normal waits for the
reading to stay in range for the monitor's stabilization window before closing the episode.

**Power and energy in a voltage message.** If the same device also reports power (and energy), a voltage
message can use `%power%` and `%energy%` — useful on a combined energy meter:

```
%monitor%: %voltage% V while the pump draws %power% W
→ Voltagem Fase A: 204.3 V while the pump draws 1480 W
```

On a device without a power capability the same template reads `Voltagem Fase A: 204.3 V while the pump
draws  W` (the placeholder renders as nothing, not `0`). These two are available inside message templates;
they are not separate Flow tokens on the voltage triggers.

**Comparing two phases.** The condition *Two voltage monitors are more than N% apart* uses
|A − B| / ((A + B) / 2) × 100 of the two current readings.

| Fase A | Fase B | Imbalance | "more than 5 %" | "more than 10 %" | "more than 0 %" |
|---|---|---|---|---|---|
| 220 V | 240 V | `8.7 %` | true | false | true |
| 220 V | 220 V | `0 %` | false | false | false |
| 220 V | (no reading yet) | — | false | false | false |

"More than" is strict, so identical readings are never "more than 0 %" apart.

## 6. Groups: are all the doors closed?

**Set up.** Settings → Groups → new group **"Portas e janelas"**, type *Contact (doors/windows)*, expected
*closed*, three devices. Then **Group mismatch detected** / **Group matched again** triggers, the condition
*has a mismatch*, and **Check state group** (Advanced Flow) for an on-demand reading.

The three message boxes are the sentence for 0, 1 and several mismatches. *Fill default wording for this
type* fills them in the *Default message language* chosen under Settings → Monitors → Message format (Same as
Homey, English, Português, Nederlands, Deutsch, Français, Italiano, Svenska, Norsk, Español or Dansk; Homey's
own language when it is left on *Same as Homey*, English if the app has no wording for it), and only when you
click it, never over text you wrote. The same language is what a **new** Activity, State or Voltage monitor
starts with; monitors that already exist keep their text.
Placeholders: `%group%`, `%count%`, `%items%` and `%count:mismatch|mismatches%`.

With the English defaults and the three devices *Porta da Sala*, *Janela do Quarto*, *Porta da Cozinha*:

| Open | `mismatch_count` | `match_count` | `mismatch_list` | `message` |
|---|---|---|---|---|
| none | `0` | `3` | empty | `All doors and windows are closed.` |
| Porta da Sala | `1` | `2` | `Porta da Sala` | `Porta da Sala is open.` |
| Porta da Sala, Janela do Quarto | `2` | `1` | `Porta da Sala` and `Janela do Quarto` on separate lines | `2 doors/windows open: Porta da Sala and Janela do Quarto.` |

`mismatch_list` is one name per line (handy for a loop or a notification), while `%items%` inside a message
is a readable list joined by the group's conjunction (`and`, or `e` in Portuguese). Your own wording in
Portuguese, written once in the group's form:

```
0:    Todas as portas e janelas estão fechadas.
1:    %items% está aberta.
many: Há %count% itens abertos: %items%.
→ Há 2 itens abertos: Porta da Sala e Janela do Quarto.
```

**Check state group** returns `group_name`, `checked_count`, `match_count`, `mismatch_count`,
`mismatch_list` and `message`; **Get group statistics** returns `mismatch_seconds`,
`mismatch_duration_human` and `check_count` (an estimate from the 5-minute poll, not an exact stopwatch).

## 7. Availability

Nothing to set up for the scan; add a watchdog to a device you want its own limit and Flow for.

| Card | Tokens |
|---|---|
| **A device needs attention** (scan; fires once per new problem, the first scan is silent) | `device`, `zone`, `last_seen`, `reason` (`unavailable`, `stale` or `low_battery`), `battery` (`0` when not a battery problem) |
| **Device became unavailable** (watchdog) | `device`, `zone`, `last_seen`, `reason` |
| **Device became available** (watchdog) | `device`, `downtime` (for example `5 h 29 min`) |
| **Watched device battery is low** | `device`, `zone`, `battery` |

## 8. Placeholders inside message templates

| Monitor | Placeholders |
|---|---|
| Activity | `%device%` `%monitor%` `%power%` `%time%` `%duration%` `%duration_human%` `%energy%` `%energy_today%` `%average_power%` `%max_power%` `%average_current%` `%max_current%` `%cost%` `%cost_today%` `%cost_text%` `%cost_today_text%` `%count%` `%count:word\|words%` |
| State | the same set, plus `%label%` (the state just entered) |
| Voltage | `%device%` `%monitor%` `%voltage%` `%event_type%` `%time%` `%duration%` `%duration_human%` `%min_voltage%` `%max_voltage%` `%average_voltage%` `%power%` `%energy%` |
| Group | `%group%` `%count%` `%items%` `%count:word\|words%` |

A placeholder that does not apply to that message renders as nothing. One switch in Settings (message
format) turns `1.5 kWh` into `1,5 kWh` in messages.

## 9. If something looks wrong

- **A number token is `0`** — there is no data for it yet (a period with no cycles, a device without current)
  or, for cost, no price is set.
- **A number has many decimals in a Flow** — rounding happens as the token leaves the app; a Flow saved before
  that was added still shows the old text in entries already written.
- **The Timeline shows `...T14:02:00.000Z`** — you used `timestamp`; use `time`.
- **Tokens do not appear on an action card** — Standard Flow does not show action-card tokens; use Advanced
  Flow, or react to the monitor's own trigger card.
- **A Flow for a deleted monitor errors with "not found"** — the card reports it on purpose, so a broken Flow
  is visible; pick the monitor again.
- **Settings shows a monitor as "Calibrating"** — it is using a default threshold until the device's own
  history shows a clear standby/active split; hover the badge to see how far it got. A split that was found
  is applied at the next check, which can take up to 30 minutes.
