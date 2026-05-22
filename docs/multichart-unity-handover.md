# Multi-Chart Per Stem — Unity Engineer Handover

**Author:** backend / studio team
**Date:** 2026-05-22
**Status:** Backend shipped end-to-end. Existing single-chart Unity flow keeps working unchanged; multi-chart picker is your move.

This is what you need on the Unity side to surface the "multiple chart variants per instrument" feature that the studio now ships. Read top to bottom — every section is short.

---

## 1. TL;DR for the impatient

- A published song can now ship **multiple charts for the same instrument**. They live side-by-side in `notes.chart` as numbered alternate sections — e.g. `[ExpertSingle]`, `[ExpertSingle2]`, `[ExpertSingle3]` for three guitar variants on one song.
- The **unnumbered section is the primary** (e.g. `[ExpertSingle]`). Stock Clone Hero only sees the unnumbered one, so the published file stays CH-playable with zero changes.
- Each chart is **labelled with the generator preset** that produced it (`v10-polyphonic-basic-pitch`, `drums-v1`, etc.) so the user can pick a flavour they enjoy.
- Two new metadata sources describe the variants:
  - `song.ini` gets one **`[beatmap_N]` section per variant**, in publish order. Read this first — it's lightweight and gives you everything you need to build the picker before parsing the chart.
  - `notes.chart` gets a **`[Beatmaps]` block** that lists every emitted section name with its source preset and an active/alt tag. Use it as a cross-check when loading a variant.
- Recommended Unity flow: parse `song.ini` first → build a picker UI (one option per `[beatmap_N]`) → when the user picks one, load its `sections` list from `notes.chart`. Section names from `song.ini` and `notes.chart` are guaranteed to match by construction.

---

## 2. Authoritative file formats

### 2.1 `song.ini` — `[beatmap_N]` sections

Lives in the published song folder alongside the existing `[song]`, `[onboarding]`, `[real_notes]`, `[background]` blocks. One section per chart variant. Numbering starts at `1` and matches the chart's section-number suffix (see §2.2).

Example (one guitar primary + two alternates, plus a drums primary):

```ini
[beatmap_1]
id = 4d038f0672dc
name = v10-polyphonic-basic-pitch
preset = v10-polyphonic-basic-pitch
stem = guitar
is_active = true
sections = ExpertSingle,HardSingle,MediumSingle,EasySingle

[beatmap_2]
id = a91b4d038f0672
name = v9-sparse-strong-beat
preset = v9-sparse-strong-beat
stem = guitar
is_active = false
sections = ExpertSingle2,HardSingle2,MediumSingle2,EasySingle2

[beatmap_3]
id = b32c91b4d038f0
name = v8-crepe-pitch
preset = v8-crepe-pitch
stem = guitar
is_active = false
sections = ExpertSingle3,HardSingle3,MediumSingle3,EasySingle3

[beatmap_4]
id = c43da91b4d038f
name = drums-v1
preset = drums-v1
stem = drums
is_active = true
sections = ExpertDrums,HardDrums,MediumDrums,EasyDrums
```

#### Field reference

| Key | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable beatmap identifier (12-char hex). Useful for analytics, "remember user's last choice", etc. Don't display it. |
| `name` | string | Display name. In v1 this is the same as `preset`. The studio reserves a separate human-readable name slot for v2 — write your picker against `name`, not `preset`, so it picks up the friendlier text when we ship it. |
| `preset` | string | The generator preset slug that produced this chart (`v10-polyphonic-basic-pitch`, `drums-v1`, `v1`, etc.). Stable identifier; safe to use in a "remember last choice" key. |
| `stem` | string | One of `guitar`, `bass`, `drums`, `vocals`, `rhythm`. Tells you which instrument lane the chart's sections target. |
| `is_active` | `true` / `false` (lowercase literal) | The primary variant for its stem — the one whose chart sections are *unnumbered* and therefore visible to stock Clone Hero. Exactly one variant per stem is active. |
| `sections` | comma-joined list | The notes.chart section names this variant contributes. Always in difficulty order `Expert*, Hard*, Medium*, Easy*`. A variant that didn't generate all four difficulties will have a shorter list. |

#### Parsing notes

- Numbering: `[beatmap_N]` starts at 1 and increases by 1 per variant in publish order. Don't assume contiguous numbering across stems (e.g. you might see guitar beatmaps as 1/2/3 and drums beatmaps as 4 — different stems share one counter).
- Ordering: variants are emitted **grouped by stem**, primary first per stem, then alternates alphabetical by preset name. Stems are emitted in the order their first variant was encountered. So a reader iterating `[beatmap_N]` in numeric order sees a stable, predictable layout.
- Escaping: free-text fields (`id`, `name`, `preset`, `stem`, individual `sections` entries) have CR/LF stripped to a space and any embedded double quotes escaped to `\"`. song.ini is line-oriented; don't expect to parse multi-line values.
- The existing `[song]` and per-difficulty `[<diff>_stats]` blocks describe the **primary variant only**. They are unchanged in shape and meaning. Stock CH-style tools still work.

### 2.2 `notes.chart` — `[Beatmaps]` metadata block

`merge_beatmap_charts` (in the publish path) emits a `[Beatmaps]` section near the top of the chart, after `[Song]` / `[SyncTrack]` / `[Events]` and before the note-track sections. It's an authoritative table of every emitted note-track section in the file.

Example (matches the song.ini above):

```
[Beatmaps]
{
  ExpertSingle = preset="v10-polyphonic-basic-pitch" name="active" beatmap_id="4d038f0672dc"
  HardSingle = preset="v10-polyphonic-basic-pitch" name="active" beatmap_id="4d038f0672dc"
  MediumSingle = preset="v10-polyphonic-basic-pitch" name="active" beatmap_id="4d038f0672dc"
  EasySingle = preset="v10-polyphonic-basic-pitch" name="active" beatmap_id="4d038f0672dc"
  ExpertSingle2 = preset="v9-sparse-strong-beat" name="alt" beatmap_id="a91b4d038f0672"
  HardSingle2 = preset="v9-sparse-strong-beat" name="alt" beatmap_id="a91b4d038f0672"
  ...
  ExpertDrums = preset="drums-v1" name="active" beatmap_id="c43da91b4d038f"
  ...
}
```

#### Row format

Each row is `<section_name> = preset="<preset>" name="<active|alt>" beatmap_id="<id>"`. One row per emitted note-track section (so a four-difficulty variant contributes four rows).

| Field | Meaning |
| --- | --- |
| `<section_name>` | The note-track section header in this same file (e.g. `ExpertSingle2`). Each section name is unique. |
| `preset` | Same slug as the song.ini `preset` field. Quoted. |
| `name` | `"active"` for sections belonging to the primary variant for that stem; `"alt"` for everything else. **NB:** this collides nomenclature-wise with the song.ini `name` field (which is a display name). They are different keys. |
| `beatmap_id` | Same id as the song.ini `id` field. Quoted. |

#### Section-name conventions

Standard Clone Hero conventions for the suffix:

| Stem | Section suffix |
| --- | --- |
| `guitar` | `Single` (e.g. `ExpertSingle`) |
| `bass` | `DoubleBass` (e.g. `ExpertDoubleBass`) |
| `drums` | `Drums` (e.g. `ExpertDrums`) |
| `rhythm` | `DoubleBass` (legacy alias — same as `bass`) |
| `vocals` | not exported into note tracks today; see the vocal-beatmap handover for `[JamseshVocals]` |

Difficulty prefix is `Expert` / `Hard` / `Medium` / `Easy`.

The **primary** variant gets the unnumbered name (e.g. `ExpertSingle`). Numbered alternates start at `2` and increment per additional variant of the same stem (`ExpertSingle2`, `ExpertSingle3`, …). The number does NOT correspond to `beatmap_N` in song.ini — they are independent counters. Use the `sections` list in song.ini as the source of truth for "which chart sections belong to this variant."

#### Cleanup the publish pipeline does for you

- Unknown sections in `notes.chart` and unknown sections in `song.ini` are ignored by stock CH. The new metadata is fully additive.
- `[Beatmaps]` is rewritten from scratch on every publish. Don't merge it; replace.
- If a variant generated only some difficulties (e.g. Expert + Hard, no Medium/Easy), only the difficulties it produced get rows. The `beatmap_N` counter still advances by one for that variant.

---

## 3. Recommended Unity-side flow

```
parse song.ini → build per-stem picker UI → user picks variant → load picked variant's `sections` from notes.chart
```

1. **Open `song.ini`.** Parse the standard `[song]` block as before for title/artist/album/etc.
2. **Enumerate every `[beatmap_N]` section in order.** Group them by `stem`. You'll typically see 0..1 per stem in older songs (no `[beatmap_N]` sections at all → fall back to the legacy single-chart flow), and 1..N per stem in newer songs.
3. **Build a UI affordance per stem** showing the user the available variants. Recommended UI:
   - "Guitar: [V10 — Polyphonic ▾]" dropdown.
   - The default-selected option is the `is_active = true` variant for that stem (this is the one stock CH would have shown).
   - The dropdown's option label is `name` (which is the preset slug for v1 — fine as a stop-gap; we'll ship a friendlier name later).
4. **When the user picks a non-default variant**, load the `sections` list from that `[beatmap_N]`. Each entry is a literal section name that exists in `notes.chart` — go open the chart, find those sections, and load them as you would `[ExpertSingle]` today.
5. **Persist the user's choice per song.** Key it by `beatmap_id` (stable across re-publishes if the chart wasn't re-generated) or by `preset` (stable across re-generations of the same preset). Don't key it by section name — primary/alt assignment can flip between publishes.

### Defensive parsing

- A song with no `[beatmap_N]` sections is a legacy publish. Fall back to your current flow — read `[ExpertSingle]` etc. directly. Forwards-compatibility for free.
- A `[beatmap_N]` whose `sections` list references a section name that's missing from `notes.chart` is malformed — skip the variant and log a warning. Should never happen in practice; the studio writes both files atomically.
- A song.ini with **only** non-primary variants for a stem (no `is_active = true`) shouldn't happen — the publish pipeline guarantees exactly one primary per stem. Treat as malformed and skip.

---

## 4. CH compatibility

The whole multi-chart system is designed to be **invisible to stock Clone Hero**:

- Stock CH reads the unnumbered `[ExpertSingle]` and ignores `[ExpertSingle2]`, `[ExpertSingle3]`, etc.
- Stock CH ignores unknown song.ini sections like `[beatmap_N]`.
- The existing `[song]` and `[<diff>_stats]` blocks in song.ini still describe the primary variant.

Jamsesh is the only thing that surfaces the alternates. If you ever need a CH-compatible-only export, strip everything past the first `[ExpertSingle]` per stem and drop the `[Beatmaps]` block — but you won't need to for normal play.

---

## 5. Schema versioning

- The current `[beatmap_N]` schema is **v1**. There is no explicit `Version` line yet; if we add one in v2 we'll define it as the first key inside `[beatmap_1]`. Don't depend on `Version` being absent — tolerate it being present.
- We may add a separate `display_name` field in v2 distinct from `name` (today they're the same). When that happens, keep using `name` for the picker label — it's the contract.
- We may add fields to `[Beatmaps]` rows (e.g. `difficulty="hard"` to avoid the parser having to derive it from the section-name prefix). Tolerate unknown `key="value"` pairs in row text — split on whitespace and parse only the keys you recognise.

---

## 6. Open work for Unity (for your TODO list)

- Implement the song.ini `[beatmap_N]` parser.
- Add the per-stem variant picker UI.
- Wire the picker's selection through to chart-loading so the chosen sections come from `notes.chart` (not necessarily the unnumbered ones).
- Persist user choice keyed by `(song_id, stem, preset)` or similar.
- Surface a "this song has alternates" indicator in song-select even when the user hasn't opened the song yet (read `song.ini` lazily in the library scan).
- *(Optional, low priority)* Cross-check loaded sections against the chart's `[Beatmaps]` block as a sanity guard — log if they diverge.

---

## 7. Reference

- Studio-side source of truth: `web/backend/app/services/chart_generator.py::merge_beatmap_charts` (chart-side) and `web/backend/app/services/stems.py::write_song_ini` (ini-side).
- Spec doc: `docs/superpowers/specs/2026-05-22-multi-beatmap-chart-design.md` (chart format), `docs/superpowers/specs/2026-05-22-chart-iteration-loop-design.md` §A (ini format).
- Test fixtures showing every variant: `web/backend/tests/test_chart_merge_multi_beatmap.py`, `web/backend/tests/test_write_song_ini_beatmaps.py`.

Ping the studio team if anything in this doc disagrees with what you see in a real published file.
