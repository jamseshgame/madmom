# Guitar Lesson 1 — Tutorial Authoring Design

**Date:** 2026-06-11
**Target:** beatmap.jamsesh.co (prod). Author a new onboarding tutorial chart
end-to-end via the API, matching `BeatmapEditor.tsx`'s on-disk serialization so
it round-trips in the editor and publishes correctly.

## Goal

The first guitar lesson for brand-new users. Teach each mechanic bit by bit,
following the FigJam structure (Buttons/controller · Mechanics · Visuals · VO),
using:
- the **configured scene events** (`onboard_*` from SCENE_EVENTS.md) for the
  exposition steps,
- the recorded **ElevenLabs VO batch** (`ElevenLabs_Jamsesh_Guitar_Tutorial_1`,
  12 clips) as narration,
- **real-note practice sequences** (`R` notes + a guitar real-notes pack) gated
  by STEPs with **retry-on-fail** VO,
- **real music segments** spliced from the **EasySingle** chart of source track
  `d70352c3012c` ("Head Chef" by Divers, guitar beatmap `9ece9b66cfb4`).

## Source material (verified via API)

- **VO batch** (durations probed): 12 clips, 1.6s–12.2s. Map to FigJam beats.
- **Source song**: Head Chef, BPM 172.266, resolution 192. EasySingle has 317
  notes on lanes 0–3 (green/red/yellow/blue), frequent `E slide 2` markers.
- **Real-notes packs available**: 8 packs × 4 scales, pre-rendered. Using
  `acoustic-steel` + `a-minor-pentatonic` (bright, forgiving) for practice notes.

## Tutorial timeline (tutorial chart: BPM 120, res 192 → 1 beat = 0.5s)

Sequenced as exposition STEPs (`required=0`, never fail) carrying scene cues +
VO, then interactive STEPs (`required=N`, retry VO) for practice, then MUSIC
segments. VO events fire on the STEP's tick; the runtime pauses the runway
during VO (per TUTORIAL_SPEC game-design hooks).

| # | FigJam beat | Scene events | VO clip | Interaction |
|---|---|---|---|---|
| 1 | Welcome / pitch | — | 01 "So I hear you…", 02 "Ok, if I'm going to sign you…" | none (`required=0`) |
| 2 | Hand positioning | `onboard_handindicator_show`, `onboard_L`, `onboard_R` | 03 "Show me how you'd hold a guitar", 04 "Holding your controllers…" | none |
| 3 | Confirm grip | `onboard_handindicator_flash` | 05 "You've got it" | none |
| 4 | Active lane / left hand | `onboard_L`, `onboard_L_primary`, `onboard_controllerfretslide` | 06 "You can move your left hand up and down the neck" | none |
| 5 | Note path / highway | `onboard_highway_show` | 07 "Now here's the note path" | none |
| 6 | Beat line | `onboard_beatline_show`, `onboard_beatline_flash` | 08 "This is the beat line" | none |
| 7 | First gem (1 note) | `onboard_R` | 09 "Let's try playing a note with this gem coming now" | STEP `first_gem` `required=1` retry→09 |
| 8 | Strum mechanic | `onboard_R` | 10 "When the gem hits the beat line, strum with your right hand" | STEP `strum_one` `required=1` retry→10 |
| 9 | Practice 3 notes | — | 11 "Try 3 more notes" | STEP `practice_three` `required=3` retry→11 |
| 10 | Real music A | `onboard_highway_show` | — | MUSIC seg A (Head Chef Easy), `required≈4` retry→11 |
| 11 | Real music B | — | — | MUSIC seg B (Head Chef Easy), `required≈5` |
| 12 | Closing | — | 12 "You're doing great" | none (`required=0`) |

### Practice notes (`[ExpertSingle]`)
`R` notes with `E realnotes_pack acoustic-steel` + `E realnotes_scale
a-minor-pentatonic` at tick 0. Steps 7–9 place: 1 note (green), 1 note (green),
then 3 notes (green/red/yellow) — spaced ~1 beat apart inside each STEP's tick
window. Retry logic = each interactive STEP has `retry_vo` pointing at its own
VO clip and replays on `hits < required`.

### Music segments (`[MusicSeg_*]` + MUSIC events)
Two windows sliced from Head Chef EasySingle, ticks renormalized to start at 0,
`E slide` markers dropped (slides aren't taught in lesson 1), notes kept as `N`.
MUSIC line uses `source="headchef" stem="song" start_ms=… duration_ms=…
bpm=172.27 resolution=192`. `[ImportedSources]` declares
`headchef = track="d70352c3012c" beatmap="9ece9b66cfb4" name="Head Chef"` so
publish copies `sources/headchef/song.ogg`.

## On-disk chart structure (order matters)
```
[Song] / [SyncTrack] / [Events] (scene onboard_* cues) /
[ExpertSingle] (practice R notes) /
[ImportedSources] / [TutorialScript] / [MusicSeg_a] / [MusicSeg_b]
```
song.ini: `[onboarding] onboarding = True` (already from blank-tutorial);
`realnotes = True` is stamped by publish's `_bundle_realnotes` when it sees the
`R` notes — no manual flag needed.

## Execution
1. `POST /api/tracks/blank-tutorial` (name "Guitar Lesson 1", bpm 120, ~200s).
2. `POST …/vo/from-library` ×12 → capture rel_paths.
3. Build full chart text in a script (slice Easy segments, emit practice R
   notes, lay out TutorialScript) → `PUT …/chart`.
4. `GET …/chart` back; validate it parses (sections present, TutorialScript
   lines well-formed, MusicSeg ticks start at 0, scene events recognized).

## Validation / done criteria
- Chart round-trips through `parseChart`/`parseTutorialSection` semantics
  (verified by re-fetch + a parser check mirroring the editor regexes).
- All 12 VO files exist in the beatmap `vo/` dir and are referenced.
- Scene event names are all in `SCENE_EVENT_CATALOG`.
- MUSIC events reference existing `[MusicSeg_*]` sections; `[ImportedSources]`
  resolves to a real source beatmap.
- Editor URL returned for manual review.
