# Scene events — design

**Status:** draft
**Date:** 2026-05-07
**Author:** Freshdex
**Scope:** Add scene-control cues to the .chart format, expose them in the manual beatmap editor, and document the contract for the Unity engineer.

---

## Goal

Let chart authors drive Unity-side scene state from a song's chart file:

1. **Global flags** that apply for the whole song from the moment it loads (crowd, lasers).
2. **Timeline events** that fire at specific ticks during playback (controller onboarding cues, hand indicator, highway, beatline).

These cues are independent of the existing tutorial mode — any song can carry them.

## Storage format

### Global flags — new `[Scene]` section

```chart
[Scene]
{
  floorcrowd = 0.1
  lasers_center = 0.2
  lasers_left = 0
  lasers_right = 0.1
}
```

- Plain `key = value` lines, one per flag.
- Values are decimal numbers. `0` means off; `0.1` means on; higher values (`0.2`, `0.3`, …) escalate intensity. The decimal scheme keeps room for future intensity steps without renaming keys.
- Unknown keys must be ignored by the engine (forward compatibility).
- Missing section means "all defaults" (everything off).
- Defaults: every defined flag defaults to `0` if absent.

#### Defined flags

| Key | Effect | Values |
|---|---|---|
| `floorcrowd` | Crowd presence on the floor | `0` off · `0.1` on · `0.2` on + intense · *future steps* |
| `lasers_center` | Center laser cluster | `0` off · `0.1` / `0.2` / `0.3` increasing intensity |
| `lasers_left` | Left laser cluster | same as center |
| `lasers_right` | Right laser cluster | same as center |

### Timeline events — standard `[Events]` section

```chart
[Events]
{
  0 = E "section Intro"
  36672 = E "onboard_L"
  36864 = E "onboard_L_primary 232"
  37056 = E "onboard_handindicator_flash"
  192000 = E "onboard_highway_show"
}
```

- Uses the existing standard chart `[Events]` format: `<tick> = E "<payload>"`.
- Payload is a single-token event name optionally followed by a space and a duration in ticks: `E "<name>"` or `E "<name> <duration>"`.
- A missing duration (or duration `0`) means an instantaneous trigger (one-shot fire).
- A non-zero duration means the effect persists for that many ticks; the engine is responsible for ending it (e.g. fading a glow back out, or hiding a panel) at `tick + duration`.
- Unknown event names must be ignored by the engine. Unknown trailing tokens must be ignored.
- Ordering inside the section is by tick (ascending). Multiple events at the same tick are allowed.
- This section coexists with the existing chart-level `section …` and `lyric …` events that already use `E "…"`.

## Event catalog

All event names are lowercase, snake_case, prefixed `onboard_`. Duration is optional unless noted.

### Controller — left hand (`onboard_L_*`)

| Event | Meaning | Duration |
|---|---|---|
| `onboard_L` | Show the left controller centered in the player's view | optional (omit = stays until `onboard_L_hide`-style cue is added later) |
| `onboard_L_rotate` | Slowly rotate the controller in place | optional (length of rotation animation) |
| `onboard_L_primary` | Glow the primary face button | optional (length of glow) |
| `onboard_L_secondary` | Glow the secondary face button | optional |
| `onboard_L_menu` | Glow the menu button | optional |
| `onboard_L_trigger` | Glow the trigger | optional |
| `onboard_L_grip` | Glow the grip | optional |
| `onboard_L_thumbstick` | Glow the thumbstick (movement axis) | optional |
| `onboard_L_stickclick` | Glow the stick-click input | optional |

### Controller — right hand (`onboard_R_*`)

Mirrors the left side. Same semantics, same duration rules:

`onboard_R`, `onboard_R_rotate`, `onboard_R_primary`, `onboard_R_secondary`, `onboard_R_menu`, `onboard_R_trigger`, `onboard_R_grip`, `onboard_R_thumbstick`, `onboard_R_stickclick`.

### Hand indicator (`onboard_handindicator_*`)

| Event | Meaning | Duration |
|---|---|---|
| `onboard_handindicator_show` | Show the hand-indicator overlay | optional |
| `onboard_handindicator_hide` | Hide the hand-indicator overlay | n/a (instant) |
| `onboard_handindicator_flash` | One-shot flash to draw attention | n/a (instant) |

### Highway (`onboard_highway_*`)

| Event | Meaning | Duration |
|---|---|---|
| `onboard_highway_show` | Show the gameplay highway | optional |
| `onboard_highway_hide` | Hide the gameplay highway | n/a (instant) |

### Beatline (`onboard_beatline_*`)

| Event | Meaning | Duration |
|---|---|---|
| `onboard_beatline_show` | Show the beatline overlay | optional |
| `onboard_beatline_hide` | Hide the beatline overlay | n/a (instant) |
| `onboard_beatline_flash` | One-shot flash on the current beat | n/a (instant) |
| `onboard_beatline_showsequence` | Begin a scripted highlight sequence on the beatline | optional (sequence length) |
| `onboard_beatline_hidesequence` | End / cancel the highlight sequence | n/a (instant) |

### Misc

| Event | Meaning | Duration |
|---|---|---|
| `onboard_controllerfretslide` | Demo the fret-slide gesture on the visible controller | optional |

## Editor changes (web/frontend `BeatmapEditor.tsx`)

### Right sidebar — new "Scene" panel

- New collapsible card titled **Scene**, sibling to the existing tutorial card. Always visible (independent of tutorial mode).
- Four number inputs:
  - `floorcrowd`
  - `lasers_center`
  - `lasers_left`
  - `lasers_right`
- Each input: `step=0.1`, `min=0`, no max. Empty/blank means "use default" and the key is omitted on save (no `[Scene]` line written).
- Reads from / writes to a `[Scene]` section. Round-trips unknown keys verbatim (preserve future flags the editor doesn't yet know about).

### Timeline — new "Scene" row

- A second event row beneath the tutorial timeline strip. Always rendered (no tutorial-mode gate).
- Visual: thin tick mark for instantaneous events, horizontal band for durational events. Color distinct from tutorial events.
- Interactions match the tutorial timeline:
  - Click empty area → no-op (no auto-add; use the picker).
  - Click event → select.
  - Drag body → move tick.
  - Drag right edge → resize duration (only for events that accept duration).
  - Backspace → delete selected event.

### Add-event picker

- New button **+ Scene event** above the timeline. Opens a categorized dropdown:
  - Controllers L
  - Controllers R
  - Hand indicator
  - Highway
  - Beatline
  - Misc
- Selecting an entry inserts the event at the current playhead tick. Default duration: 384 ticks for events that accept a duration; 0 (instant) otherwise.

### Parsing & serialization

- Parse `[Scene]`: split on lines, regex `^\s*(\w+)\s*=\s*([0-9]*\.?[0-9]+)\s*$`. Unknown keys are stored in a passthrough map and re-emitted on save.
- Parse `[Events]`: existing logic plus new regex `^\s*(\d+)\s*=\s*E\s*"(\w+)(?:\s+(\d+))?"\s*$` matched against `onboard_*` names; non-matching `E` lines (e.g. `section Verse`) are kept verbatim and re-emitted unchanged.
- Save: drop the existing `[Scene]` and any `onboard_*` `[Events]` lines, then re-emit from editor state. Non-onboard `[Events]` lines pass through.

### Mid-file note for the implementer

- Use the same passthrough strategy already used for `[MusicSeg_*]` sections: keep an opaque map for unknown content so we don't lose data on round-trip.

## Engine-side notes (Unity)

The handover doc lives at `web/docs/SCENE_EVENTS.md` and contains:

- Format spec (mirrors this doc's "Storage format" + "Event catalog" sections).
- Suggested architecture:
  - `SceneState` ScriptableObject populated from `[Scene]` at song-load. Hooks for each flag → existing scene controllers (crowd, lasers).
  - `SceneEventBus` MonoBehaviour pumped by the song clock. Subscribes to `<tick, name, duration>` triples; raises a typed event per category. Per-event handlers live near the affected GameObject (controller rig, highway controller, beatline controller).
  - Forward compatibility: unknown events log a warning at editor-time only; ignored at runtime.
  - Duration handling: a small scheduler that, when an event with `duration > 0` fires, schedules the matching "end" effect at `tick + duration`. Engine decides what "end" means per event (fade glow, hide panel, etc.).

## Out of scope

- No engine code is being written in this project — only editor + format + handover doc.
- No retroactive migration: existing charts have no `[Scene]` and no `onboard_*` events; they keep working unchanged.
- No support for non-`onboard_*` payloads in `[Events]` beyond what the chart already carries (sections/lyrics pass through untouched).
- No per-event intensity field; intensity is expressed via global flags only. Per-event customization (e.g. glow color) can be added later by extending the payload format.

## Risks

- **Round-trip loss of unknown keys** — mitigated by passthrough storage in both `[Scene]` and `[Events]`.
- **Conflict with existing chart tooling** — `[Events]` is shared with section/lyric markers; tested by ensuring non-`onboard_*` lines are preserved verbatim.
- **Duration semantics ambiguous to authors** — handover doc spells out which events accept duration and what "end" means. Editor only shows the right-edge handle on duration-bearing events.
