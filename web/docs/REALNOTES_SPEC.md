# Jamsesh Real-Notes — Spec for the Unity Runtime

**Status:** authoring-complete in Jamsesh Studio. Runtime parsing, sample
playback, and section pass/fail are the Unity side's responsibility.

This document describes the on-disk format produced by **Publish to Game**
for songs that include real-note playback (pitched samples fired on note
hit). It's orthogonal to tutorial mode — a song can use one, both, or
neither. If `song.ini` lacks `realnotes = True`, ignore everything below.

A test bench song that exercises every pack × scale × slot combination
ships at `JamseshSongContent/SongInbox/Jamsesh QA - Realnote Test v1/`.
Walk through it once to verify your implementation hits every code path.

---

## 1. Folder layout

For a song published with real-notes on, the inbox folder will contain:

```
song.ini
song.ogg                          ; full mix
notes_fixed_slides.chart          ; the chart
album.png                         ; (optional)
vocals.ogg drums.ogg rhythm.ogg   ; per-stem oggs (only those provided)
guitar.ogg piano.ogg crowd.ogg
realnotes/                        ; instrument-sample bundles (NEW)
  <pack-id>/
    <scale-id>/
      lane_1.ogg lane_2.ogg lane_3.ogg lane_4.ogg lane_5.ogg
      chord_12.ogg chord_23.ogg chord_34.ogg chord_45.ogg
      open.ogg
    <other-scale-id>/
      ...
  <other-pack-id>/
    ...
vo/                               ; tutorial / retry narration (only if tutorial too)
  tutorial.ogg                    ; collated VO bundle; STEP retry_vo points here
  clips/                          ; editor-only — individual per-slug clips
    tut_intro.ogg
    sec_0.ogg sec_1.ogg ...
    retry.ogg
```

The `vo/clips/` subdirectory exists only so Studio can round-trip a
published song back into the editor and re-author individual VO clips
without losing the source audio. **The Unity client should ignore
`vo/clips/` entirely** — it duplicates content that's already inside
`tutorial.ogg` at the slice offsets the chart references. Treat it like
a `.psd` next to a flattened `.png`.

`realnotes/<pack>/<scale>/` holds 10 pre-rendered OGGs per combo. The
chart references combos by pack-id + scale-id strings; you load and cache
the matching 10 OGGs at song-load time.

**Combos shipped**: one folder per `(pack, scale)` tuple actually
referenced by an `R` note in the chart. Songs that only use one combo
ship one folder; the Realnote Test v1 bench ships 32 (= 8 packs × 4
scales). Don't assume any particular set is present — read the folder
structure or walk the chart.

---

## 2. `song.ini` flag

A new key in the existing `[song]` section:

```ini
[song]
name = Crashing Down
artist = Everfall
... (standard CH keys) ...
realnotes = True
```

Use this as the cheap "do I need the real-notes subsystem?" check before
loading the chart. Songs without it have no `R` notes and no
`realnotes/` folder.

A song can have both `realnotes = True` and `onboarding = True` — the
test bench does. The two systems share `vo/tutorial.ogg` (retry VOs live
as slices inside the collated tutorial file) but are otherwise independent.

---

## 3. Chart format — `R` notes and `E realnotes_*` events

Real-notes are playable notes that fire a pitched sample on hit. They
look almost identical to regular notes; only the type letter changes.

### Note line types in a section body

```
<tick> = N <lane> <sustain>            ; regular note (no sample fires)
<tick> = R <lane> <sustain>            ; real-note (plays a pitched sample)
<tick> = N 5 0                         ; force-HOPO modifier (existing CH)
<tick> = N 6 0                         ; tap modifier (existing CH)
```

`R` notes use the same lane numbering as `N`:

- `0..4` — colored frets (green, red, yellow, blue, orange)
- `7` — open note (whole-string strum)

There is **no lane 8** in the new format. (Old charts used lane 8 as a
sibling marker; that's gone — Studio's migration step rewrote every such
chart before publish.)

Modifier lanes (5 force-HOPO, 6 tap) still attach to regular `N` notes
the same way they always have. They don't apply to `R` notes' pitched
playback — they're a HOPO/tap input behaviour on the playable note at
the same tick.

### Pack & scale state — `E realnotes_pack` / `E realnotes_scale`

`R` notes don't carry pack/scale inline. They inherit the most recently
declared pair via `E` events:

```
<tick> = E realnotes_pack <pack-id>
<tick> = E realnotes_scale <scale-id>
```

State is **section-scoped**: when you start parsing a new
`[<section>] { ... }` block, reset active pack and scale to null. Walk
the section body in source order, updating active state on each E event
and consulting it when you encounter an `R` note. `R` notes that fire
before any declaration in their section have no pack/scale — treat as
"no sample" and just play the note silently as fallback (Studio refuses
to emit such notes, but the runtime should be defensive).

### Full section example

```
[ExpertSingle]
{
  0   = E realnotes_pack electric-distortion
  0   = E realnotes_scale e-minor-pentatonic

  1234 = R 1 0                         ; red real-note, no sustain
  1234 = N 5 0                         ; ...with a force-HOPO modifier
  1300 = R 7 480                       ; open real-note with sustain
  1500 = N 0 0                         ; regular note (no sample)

  9000 = E realnotes_scale a-minor-pentatonic   ; key change
  9100 = R 0 0
  9100 = R 1 0                         ; two-fret chord (green+red)
}
```

Parser pseudocode:

```csharp
foreach (Section sec in chart.sections) {
    string activePack = null;
    string activeScale = null;

    foreach (Line line in sec.bodyInOrder) {
        if (line.IsRealnotesPackEvent)   activePack  = line.Value;
        else if (line.IsRealnotesScaleEvent) activeScale = line.Value;
        else if (line.IsRealNote) {
            EmitRealNote(line.Tick, line.Lane, line.Sustain, activePack, activeScale);
        } else {
            EmitNormalNote(line);
        }
    }
}
```

---

## 4. Sample slot derivation — frets → slot file

When an `R` note (or cluster of `R` notes at the same tick) is hit, the
sample to fire is derived from the fret(s) the player held. The mapping
is intrinsic to the gameplay model — the chart doesn't tell you which
slot to play, it just says "this is a real-note; figure it out from the
input."

| Frets pressed at tick                          | Slot file        |
| ---------------------------------------------- | ---------------- |
| Just lane 7 (open)                             | `open.ogg`       |
| Just lane 0                                    | `lane_1.ogg`     |
| Just lane 1                                    | `lane_2.ogg`     |
| Just lane 2                                    | `lane_3.ogg`     |
| Just lane 3                                    | `lane_4.ogg`     |
| Just lane 4                                    | `lane_5.ogg`     |
| Two adjacent frets: 0+1 / 1+2 / 2+3 / 3+4      | `chord_12/23/34/45.ogg` |
| Two non-adjacent frets (e.g. 0+2)              | lower fret's solo `lane_<N>.ogg` (defensive fallback) |
| Three+ frets                                   | lowest fret's solo `lane_<N>.ogg` (defensive fallback) |

The fallbacks exist because the chart format can technically express
unusual fret combinations the game's pre-rendered packs don't cover. In
practice Studio only authors single-lane, two-adjacent-chord, or open
real-notes; the fallbacks should never fire in shipped songs.

**Pack-and-scale resolution for chords:** when an `R` note cluster
spans multiple lanes at the same tick, the cluster's `(pack, scale)` is
the *lowest-lane* `R` note's pair. Studio enforces uniformity within a
chord, but use lowest-lane resolution as a defensive rule for
hand-edited charts.

---

## 5. Pack and scale catalog (current)

You won't normally hard-code these — load whatever folders show up under
`realnotes/`. Listed here for reference / sample test cases.

**Packs (timbre)** — what instrument the sample sounds like:

| id                    | display name              | family |
| --------------------- | ------------------------- | ------ |
| `acoustic-nylon`      | Acoustic Guitar (Nylon)   | guitar |
| `acoustic-steel`      | Acoustic Guitar (Steel)   | guitar |
| `electric-clean`      | Electric Guitar (Clean)   | guitar |
| `electric-overdrive`  | Electric Guitar (Overdrive) | guitar |
| `electric-distortion` | Electric Guitar (Distortion) | guitar |
| `bass-finger`         | Bass Guitar (Finger)      | bass   |
| `bass-pick`           | Bass Guitar (Pick)        | bass   |
| `piano-acoustic`      | Acoustic Piano            | keys   |

**Scales (note progression)** — the 10-note pitch set the slot files
were rendered with. Each scale's MIDI list maps to slots 0..5 in this
order: `lane_1, lane_2, lane_3, lane_4, lane_5, open`. The four
`chord_xy` files are mixes of adjacent lane pitches and were rendered as
two-voice chords (not a separate scale entry):

| id                     | display name                |
| ---------------------- | --------------------------- |
| `c-major-pentatonic`   | C major pentatonic          |
| `a-minor-pentatonic`   | A minor pentatonic          |
| `e-minor-pentatonic`   | E minor pentatonic          |
| `d-major-pentatonic`   | D major pentatonic          |

New combos can ship by adding folders under `realnotes/` and authoring
charts that reference them — no chart-format change needed.

---

## 6. STEP pass/fail + retry VO (tutorial only)

Only relevant when `onboarding = True` and the chart has a
`[TutorialScript]` section. Real-notes have no inherent pass/fail; they
fire samples on hit and that's it. Pass-gating is layered on top via
STEPs, identical to vanilla tutorial mode but with two new fields on
STEPs whose retry clip lives in the collated VO bundle.

### STEP line shape

```
<tick> = STEP "<stepId>" required=<N> timing=<any|perfect> [retry_vo="<path>"
         [retry_start_ms=<N> retry_duration_ms=<N>]] [next="<stepId>"]
```

New fields:

- `retry_start_ms` — byte/sample-offset placeholder inside the
  `retry_vo` file. Used when the file is the collated `vo/tutorial.ogg`.
- `retry_duration_ms` — slice length. Stop playback after this many ms
  past the start offset.

When both fields are absent, fall back to whole-file playback (legacy
behaviour for any chart that points retry at a standalone clip).

### Pass/fail evaluation

A section "belongs to" the STEP whose tick begins it. The next STEP
ends it. While the playhead is inside step *i*'s region
(`[steps[i].tick, steps[i+1].tick)`):

1. Count distinct ticks at which an `R` note was hit (a chord at a
   single tick = 1 hit).
2. When the playhead crosses into step *i+1*, evaluate:
   - `credited >= steps[i].required` → advance to step *i+1*.
   - `credited <  steps[i].required` → **fail**:
     - Play the `retry_vo` slice (or whole file).
     - Seek transport back to `steps[i].tick`.
     - Reset the hit counter for step *i*. Player gets another attempt.

`required = 0` means the STEP is a transport marker (intro / outro);
never fails. STEPs with no `retry_vo` are also non-failing — the
section advances regardless of credited hits.

### Retry variants (forward-compatible)

The current shipping format has one retry slice per STEP. The collated
`vo/tutorial.ogg` is designed to grow — future songs may pack multiple
retry-message variants ("Oops, try again", "Almost — one more time",
"Let's give that another go") and pick one per fail (random / round-
robin). The chart format extension will most likely be a list of
`retry_start_ms_<n>` / `retry_duration_ms_<n>` pairs on the STEP line;
parse defensively and ignore unknown variant indices for now.

---

## 7. Acid test — Realnote Test v1

Published bench song that exercises every implemented code path:

- `JamseshSongContent/SongInbox/Jamsesh QA - Realnote Test v1/`
- 32 sections, one per `(pack, scale)` combo (8 packs × 4 scales).
- Each section: VO announcement → 10 `R` notes (one per slot:
  lane_1..lane_5, chord_12..chord_45, open) → next section.
- Section STEPs gate at `required=10 timing=any` with a retry clip
  inside `vo/tutorial.ogg` at offset (208754 ms, 1520 ms) — i.e. every
  fail plays the same "Oops, let's try that again" clip.
- Intro + outro STEPs are `required=0` (no gate).

Implementation acceptance:

1. Load song, see `realnotes = True`, load `realnotes/` folders.
2. Play through linearly with autohit on — every slot OGG should
   fire once, in the order announced by each section's VO.
3. Trigger a fail on any section (skip one note) — the retry slice
   should play and the playhead should seek back to that section's
   STEP tick. Replay should pass cleanly.
4. Confirm `[Events]` section markers track each `(pack, scale)`
   boundary so you can use them for navigation / debugging.

---

## 8. Quick implementation checklist

- [ ] Parse `song.ini`; treat `realnotes = True` as the load gate.
- [ ] At song-load, enumerate `realnotes/<pack>/<scale>/` folders and
      preload the 10 OGGs per combo into memory (or stream from disk —
      ~470 KB per combo, ~15 MB if you load all 32 of the test bench).
- [ ] Parse chart sections in source order; maintain
      `(activePack, activeScale)` state from `E realnotes_pack/scale`
      events; reset per section.
- [ ] When a fret-input pattern matches an `R` note at the playhead,
      pick the slot file by the fret-derivation table (§4) and play it
      from `realnotes/<activePack>/<activeScale>/<slot>.ogg`.
- [ ] If `onboarding = True` and the chart has STEPs, layer the
      pass/fail logic on top (§6).
- [ ] Use the Realnote Test v1 song as a regression bench whenever the
      sample-playback path changes.

---

## 9. Imported sources + slice-mode MUSIC events

A tutorial chart can import other beatmaps as **sources** to splice
sections from. The published folder layout grows:

```
song.ini
song.ogg                            ; tutorial's own backing
notes_fixed_slides.chart            ; the tutorial chart
sources/                            ; one folder per imported source
  src_a/
    song.ogg                        ; copy of src_a's song.ogg
  src_b/
    song.ogg
realnotes/                          ; (existing — pack/scale bundles)
vo/                                 ; (existing — collated VO)
```

The chart's `MUSIC` events in `[TutorialScript]` reference splices via
the new shape:

```
<tick> = MUSIC source="src_a" stem="song"
         start_ms=18300 duration_ms=24000
         section="MusicSeg_<id>"
         bpm=... resolution=... duration=... notes=...
         required=... timing=...
```

When `source="..."` is present, the engine plays
`sources/<source>/<stem>.ogg` from `start_ms` for `duration_ms`. The
referenced `[MusicSeg_<id>]` section holds the trimmed slice notes
(ticks renormalised to start at 0).

The legacy `MUSIC "<file>"` shape (standalone segment ogg) keeps
working for upload-based events. Distinguish by which fields are
present.

The `[ImportedSources]` section the tutorial editor writes to track
studio-side ids is **stripped at publish time** — the runtime only
needs the `source=` local ids that resolve to `sources/<id>/`.
