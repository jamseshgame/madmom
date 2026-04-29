# Jamsesh Tutorial Mode — Spec for the Unity Runtime

**Status:** authoring-complete in v1.6 (Jamsesh Studio). Runtime parsing /
playback / pass-fail logic are the Unity side's responsibility.

This document describes the on-disk format produced by **Publish to Game** for
songs flagged as tutorials. Everything is back-compat: a non-tutorial-aware
parser sees a normal Clone Hero song folder and ignores the new keys/section.

---

## 1. Folder layout

For a song published from Studio with tutorial mode on, the GitHub folder
under `JamseshSongContent/SongInbox/<Artist> - <Title>/` will contain:

```
song.ini
song.ogg                        ; full mix
notes_fixed_slides.chart        ; the chart
album.png                       ; (optional)
vocals.ogg drums.ogg rhythm.ogg ; per-stem oggs
guitar.ogg piano.ogg crowd.ogg  ; (only those provided)
tutorial_samples/               ; instrument samples (NEW)
  lane_1.ogg  lane_2.ogg  lane_3.ogg  lane_4.ogg  lane_5.ogg
  lane_1_slide_up.ogg  lane_1_slide_down.ogg  ; (auto-generated, ±2 st)
  ...                                          ; same _slide_up/_down for every base
  chord_12.ogg  chord_23.ogg  chord_34.ogg  chord_45.ogg
  chord_12_slide_up.ogg  chord_12_slide_down.ogg
  ...
  open.ogg
  open_slide_up.ogg  open_slide_down.ogg
vo/                             ; tutorial narration clips (NEW)
  ab12cd34.ogg
  ef56...ogg
  ...
```

The new bits are `tutorial_samples/`, `vo/`, plus a `[tutorial]` section in
`song.ini` and a `[TutorialScript]` section in
`notes_fixed_slides.chart`. **None of the standard Clone Hero pieces change.**

If `song.ini` does not contain `tutorial = True`, treat the song as a normal
gameplay chart and ignore everything below.

---

## 2. `song.ini` — `[tutorial]` section

```ini
[song]
name = Crashing Down
artist = Everfall
... (standard CH keys) ...

[tutorial]
tutorial = True
tutorial_voice = af_default

; 10 base instrument samples (paths relative to the song folder)
sample_lane_1   = tutorial_samples/lane_1.ogg
sample_lane_2   = tutorial_samples/lane_2.ogg
sample_lane_3   = tutorial_samples/lane_3.ogg
sample_lane_4   = tutorial_samples/lane_4.ogg
sample_lane_5   = tutorial_samples/lane_5.ogg
sample_chord_12 = tutorial_samples/chord_12.ogg
sample_chord_23 = tutorial_samples/chord_23.ogg
sample_chord_34 = tutorial_samples/chord_34.ogg
sample_chord_45 = tutorial_samples/chord_45.ogg
sample_open     = tutorial_samples/open.ogg

; auto-generated pitch-shifted variants (±2 semitones)
sample_lane_1_slide_up   = tutorial_samples/lane_1_slide_up.ogg
sample_lane_1_slide_down = tutorial_samples/lane_1_slide_down.ogg
... (one pair per base slot) ...
```

### Sample slot → chart-note semantics

The 10 base slots map to note configurations in the standard
`[*Single]`/`[*Drums]` sections of `notes_fixed_slides.chart`:

| Slot key | Notes | When to play |
|---|---|---|
| `lane_1` … `lane_5` | single note on lane 0 … 4 | a `N <lane> <sus>` line where the only lane at that tick is the matching one |
| `chord_12` | lanes 0 + 1 simultaneously | both notes share a tick |
| `chord_23` | lanes 1 + 2 | both notes share a tick |
| `chord_34` | lanes 2 + 3 | both notes share a tick |
| `chord_45` | lanes 3 + 4 | both notes share a tick |
| `open` | open note (lane 7 in CH `.chart`) | `N 7 <sus>` |

For a slide note (chart-side detection — same as today's Jamsesh
slide-event handling), substitute the matching `_slide_up` or `_slide_down`
variant for the base sample. Direction comes from the same chart marker
the gameplay runtime already uses to render slide visuals.

### Voice cloning

`tutorial_voice` is informational — the studio captures it to remember which
voice was used at authoring time. The Unity runtime doesn't need to act on it.

---

## 3. `notes_fixed_slides.chart` — `[TutorialScript]` section

A new section sits at the end of the chart. The standard `[Song]`,
`[SyncTrack]`, `[Events]`, and `[*Single]`/`[*Drums]` sections are unchanged.

```
[TutorialScript]
{
  ; from drums
  192   = STEP "intro" required=0 timing=any next="basics"
  384   = VO "vo/welcome.ogg" text="Welcome to the tutorial."
  768   = STEP "basics" required=5 timing=any retry_vo="vo/retry1.ogg" next="chords"
  ; from guitar
  2304  = STEP "chords" required=3 timing=perfect retry_vo="vo/retry2.ogg"
  2496  = VO "vo/chord_intro.ogg" text="Now try chords."
}
```

### Line grammar

```
<tick: integer> = <KIND> <args...>
```

`KIND` is `STEP` or `VO`. Whitespace separates tokens; `"…"` quotes a string
that may contain spaces. Lines starting with `;` are comments inserted by
the publisher (one per source stem) and can be skipped.

#### `VO` event

```
<tick> = VO "<file>" [text="<draft script>"]
```

| Field | Required | Notes |
|---|---|---|
| `<file>` | yes | path relative to the song folder, normally `vo/<uuid>.ogg` |
| `text=…` | optional | the script that was sent to the TTS engine. Authoring-time hint only — the runtime doesn't need to use it |

**Runtime behaviour:** at this tick, play `<file>`. The chart's normal note
flow during a VO is up to the game (see "Game-design hooks" below).

#### `MUSIC` event

```
<tick> = MUSIC "<file>" section="<section_name>" bpm=<float> resolution=<int> duration=<float> notes=<int> required=<int> timing=any|perfect [retry_vo="<file>"] [next="<id>"]
```

A music segment is a self-contained mini-lesson: at `tick` the runtime
plays the clip while displaying notes from the named section. When the
clip ends (or the player hits the next event), pass/fail is evaluated
exactly like a `STEP`.

| Field | Required | Notes |
|---|---|---|
| `<file>` | yes | path to clip, normally `segments/<id>.ogg` |
| `section` | yes | name of the `[<section>]` block in this same chart that holds the segment's notes |
| `bpm` | yes | segment's own BPM (notes are timed against this, not against the parent chart's `[SyncTrack]`) |
| `resolution` | yes | tick resolution within the segment section (usually `192`) |
| `duration` | yes | clip length in seconds — used for visualisation and as the segment's pass/fail evaluation point |
| `notes` | yes | note count, informational |
| `required`, `timing`, `retry_vo`, `next` | — | identical semantics to `STEP` |

The segment's notes live in their own block, e.g.:

```
[MusicSeg_abc123]
{
  0   = N 0 0
  192 = N 1 0
  384 = N 2 0
  ...
}
```

Note ticks here are **segment-relative** — `0` is the start of the clip.
Convert to seconds via `(tick / resolution) * (60 / bpm)` using the BPM /
resolution declared on the parent `MUSIC` line.

**Runtime behaviour:** at parent tick = `<tick>`,
1. start playing `<file>`,
2. render notes from `[<section>]` against the clip's local timeline using
   `bpm` + `resolution`,
3. count player hits per `timing` rule for the duration of the clip,
4. at `tick + (duration_in_parent_ticks)` (or when the clip ends —
   whichever comes first), evaluate pass/fail:
   - pass → advance per `next` like `STEP`,
   - fail → play `retry_vo` if set, then replay the segment.

#### `STEP` event

```
<tick> = STEP "<id>" required=<int> timing=any|perfect [retry_vo="<file>"] [next="<id>"]
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `<id>` | yes | — | unique step identifier within the chart |
| `required` | yes | `0` | minimum number of qualifying note hits in this step's range to pass. `0` means "no gate" — the step always passes |
| `timing` | yes | `any` | `any` counts every successful hit (early/perfect/late). `perfect` only counts perfect-timed hits |
| `retry_vo` | optional | — | VO file to play when the step fails (`hits < required`) before replaying it |
| `next` | optional | — | step `id` to jump to on pass. When empty, runtime advances to the **next** STEP in tick order or, if there are no more, ends the tutorial |

A STEP marks the **start** of its range. The range ends at the next STEP
in tick order, or end-of-chart if it's the last one.

---

## 4. Runtime execution model (recommended)

This is the contract the studio assumes; the Unity dev owns the actual
implementation.

### Initialization

1. Load `song.ini`. If `[tutorial] tutorial = True` is missing, fall through
   to standard gameplay.
2. Parse `[TutorialScript]` from the chart. Build:
   - An ordered list of STEP events keyed by `id`, each with its `start_tick`,
     `end_tick` (= next step's tick or end of chart), and pass criteria.
   - An ordered list of VO events.
3. Pre-decode all `tutorial_samples/*.ogg` and `vo/*.ogg` clips referenced.

### Per-tick playback

- At each VO event's tick, play the clip.
- At each note `N <lane> <sustain>` in the active difficulty's
  `[*Single]`/`[*Drums]` section, look up the sample slot per **section 2**
  and play it on note hit (or as a "preview cue" — game-design call).
- Track the current STEP. At `current.end_tick`:
  - Compute `hits` = qualifying note hits in `[start_tick, end_tick)`.
  - If `hits >= current.required`:
    - **Pass.** If `current.next` is set and resolvable, jump to that step
      (rewind the chart playhead to its `start_tick`); else advance to the
      next STEP in tick order; else end the tutorial.
  - Else:
    - **Fail.** If `retry_vo` is set, play it. Then rewind the chart playhead
      to `current.start_tick` and replay the step.

### "Qualifying hit" semantics

| `timing` | Counts as a qualifying hit |
|---|---|
| `any` | any non-miss (early window OR perfect window OR late window) |
| `perfect` | only perfect-window hits |

The window thresholds are the runtime's existing scoring constants — no
new spec.

### Slide-note sample selection

When the runtime would normally play `sample_<slot>` for a note **and** that
note is part of a slide event of direction `D ∈ {up, down}`, prefer
`sample_<slot>_slide_<D>` if present in `song.ini`. Fall back to the base
sample if the variant key is missing.

---

## 5. Game-design hooks (Unity-side, not in spec)

These are decisions the studio doesn't make — flagging them so they're not
lost:

- **Note flow during VO**: the studio assumes the runtime will pause or
  attenuate the note runway while a VO clip is playing, but doesn't enforce
  it. Pausing is the safer default for tutorial pedagogy.
- **Visual STEP boundary**: rendering the step boundary on the runway
  (banner, fade, "step 2 of 5" badge) is up to the runtime.
- **Pass/fail toast**: showing pass/fail confirmation between attempts is
  the runtime's choice.
- **Retry counting**: the chart spec doesn't cap retries; if you want
  "after 3 fails, skip the step", that's a runtime policy.
- **Idle handling**: if a STEP has `required=0`, treat as a pure exposition
  step (always passes, used to gate VO sequences before the player needs to
  do anything).

---

## 6. Backwards-compatibility checklist

The studio guarantees:

- `[song]` keys are unchanged. The `tutorial = True` flag is in a separate
  `[tutorial]` section so any parser that splits by section ignores it.
- `[Song]`, `[SyncTrack]`, `[Events]`, `[*Single]`, `[*Drums]`, etc. in the
  chart are unchanged.
- `[TutorialScript]` is appended to the chart **after** all standard
  sections. Strict CH parsers that only know the standard sections skip
  it.
- All paths in `[tutorial]` and `[TutorialScript]` are relative to the song
  folder, so the engine only needs `<song_dir>/...` lookups.

If the runtime sees `tutorial = True` but no `[TutorialScript]` section,
it should fall back to standard gameplay (treat as misauthored).

---

## 7. Authoring → on-disk worked example

A drum tutorial with one VO, two steps:

**Studio editor inputs:**

- `song.ini` form: name "Crashing Down", artist "Everfall", `tutorial = True`.
- Tutorial samples uploaded for slots `lane_1`..`lane_5` (drums kit).
- Voice ref clip uploaded.
- BeatmapEditor (Drums beatmap):
  - VO at tick 384, text "Welcome — try the kick."
  - STEP at tick 192, id `intro`, required 0, timing any, next `kicks`.
  - STEP at tick 768, id `kicks`, required 5, timing any, retry `vo/retry.ogg`.

**Published artefacts:**

`song.ini`:
```ini
[song]
name = Crashing Down
artist = Everfall
... (standard fields) ...

[tutorial]
tutorial = True
sample_lane_1 = tutorial_samples/lane_1.ogg
sample_lane_2 = tutorial_samples/lane_2.ogg
sample_lane_3 = tutorial_samples/lane_3.ogg
sample_lane_4 = tutorial_samples/lane_4.ogg
sample_lane_5 = tutorial_samples/lane_5.ogg
sample_lane_1_slide_up   = tutorial_samples/lane_1_slide_up.ogg
sample_lane_1_slide_down = tutorial_samples/lane_1_slide_down.ogg
... (per-slot ±2st variants) ...
```

`notes_fixed_slides.chart` (tail):
```
[ExpertDrums]
{
  192 = N 0 0
  ... drum hits ...
}
[TutorialScript]
{
  ; from drums
  192 = STEP "intro" required=0 timing=any next="kicks"
  384 = VO "vo/abc12345.ogg" text="Welcome — try the kick."
  768 = STEP "kicks" required=5 timing=any retry_vo="vo/retry.ogg"
}
```

`tutorial_samples/`: 10 `.ogg` files + 20 auto-generated slide variants.
`vo/abc12345.ogg`, `vo/retry.ogg`: TTS output (Chatterbox, voice-cloned
from the uploaded reference).

---

## 8. Open questions / future spec extensions

These aren't in v1.6; flagging if useful:

- Cap on retry attempts before auto-skip (currently runtime-only).
- Per-step minimum miss count ("fail if you miss > N", separate from
  "pass if you hit >= M").
- Multi-instrument STEPs (e.g. require 3 hits on guitar AND 3 hits on
  drums simultaneously).
- VO with subtitles/captions on screen — chart spec already carries
  `text="…"` on VO lines; runtime can opt to render it as captions.
- `STEP` field for "play the cue" (preview the segment without scoring)
  vs. "play live" (current behaviour).

Reach out if you need any of these — adding fields to the existing line
grammar is non-breaking.
