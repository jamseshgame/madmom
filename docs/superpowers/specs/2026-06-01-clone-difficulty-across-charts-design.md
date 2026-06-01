# Clone a difficulty across charts on a multichart track

**Date:** 2026-06-01
**Status:** Approved (brainstorming)

## Problem

A multichart track carries several beatmaps (charts) per stem — e.g. a Guitar
stem with V1…V11, each generated from a different preset. Each beatmap's
`notes.chart` holds up to four difficulty sections (`ExpertSingle`,
`HardSingle`, `MediumSingle`, `EasySingle`; or the `*Drums` / `*DoubleBass`
families for other stems).

When iterating, a charter often finds that one chart's *Expert* feels great
but another chart's *Hard* is the keeper. Today there is no way to mix
difficulties across charts. The in-editor clone-difficulty picker only copies
one difficulty into another **within a single beatmap**. We want to clone a
single difficulty **from one chart into another** on the same track, straight
from the Studio Library list — no editor session required.

## Decisions (from brainstorming)

- **Placement:** track-row action in the Studio Library list (`TracksPage`),
  not the editor.
- **Granularity:** one difficulty per clone operation.
- **Slot mapping:** remap allowed — pick the source difficulty and the target
  difficulty independently (e.g. copy Expert into the Hard slot).
- **Overwrite:** overwrite the target difficulty **in place**, after a confirm
  that warns when the target slot already has notes.
- **Direction:** the row the action is invoked from is the **source** of the
  difficulty; the user picks the **target** chart in the picker.
- **Stem scope:** same-stem only. The picker offers only other charts on the
  invoking row's stem; the backend re-validates.

## Architecture

Server-side splice driven by a small frontend picker. The backend reads the
source beatmap's `notes.chart`, lifts one difficulty section, rescales its
ticks if resolutions differ, and writes it into the target beatmap's
`notes.chart` — replacing any existing block of the target difficulty name and
leaving every other section untouched. Doing the splice server-side keeps it a
one-shot list action instead of forcing an editor load for two charts.

### 1. Backend service — `app/services/tracks.py`

New function:

```python
def clone_difficulty_across_beatmaps(
    track_id: str,
    source_beatmap_id: str,
    source_difficulty: str,
    target_beatmap_id: str,
    target_difficulty: str,
) -> dict | None
```

Behaviour:

1. Load the track. Resolve both beatmap records. Return `None` if the track or
   either beatmap record is missing (router → 404).
2. **Same-stem guard:** if `source.stem != target.stem`, raise a dedicated
   `CloneDifficultyError` (router → 422). The UI prevents this, but the service
   is the source of truth.
3. **Section-family guard:** `source_difficulty` and `target_difficulty` must
   both belong to the stem's section family (e.g. both `*Single`). Reject
   mismatches (e.g. `ExpertSingle` → `HardDrums`) with `CloneDifficultyError`.
   The valid difficulty names per stem derive from the existing
   `STEM_TO_SECTION_SUFFIX` map in `chart_generator.py` crossed with the four
   difficulty prefixes (`Expert`/`Hard`/`Medium`/`Easy`).
4. Read the source beatmap's `notes.chart`. Extract the `[<source_difficulty>]`
   block with the existing section regex (`\[Name\]\n\{([^}]*)\}`). If the
   source has no such section → `CloneDifficultyError` (router → 422,
   "source chart has no <difficulty> difficulty").
5. **Resolution rescale:** read `[Song] Resolution` from both charts. If they
   differ, scale every event's tick by `round(tick * target_res / source_res)`.
   Each chart line in a difficulty block is `  <tick> = <event...>`; only the
   leading tick is rescaled, the event payload is copied verbatim. When
   resolutions match (the common case for same-track beatmaps) the block is
   copied unchanged.
   - *Explicit assumption:* tempo maps are treated as equivalent across
     same-track beatmaps. We do **not** attempt tempo-aware re-timing — out of
     scope and rare, since same-track charts come from the same audio analysis.
6. Read the target `notes.chart`, replace the `[<target_difficulty>]` block in
   place (insert a new block if that slot was empty), and write it back. All
   other sections — `[Song]`, `[SyncTrack]`, `[Events]`, the other three
   difficulties — are preserved verbatim.
7. Return `{'target_beatmap_id', 'target_difficulty', 'source_beatmap_id',
   'source_difficulty', 'overwrote': bool}` where `overwrote` is `True` when
   the target slot already held notes.

Add a `CloneDifficultyError(Exception)` to `tracks.py` for the validation
failures above so the router can map it to 422.

### 2. Endpoint — `app/routers/tracks.py`

```
POST /api/tracks/{track_id}/beatmaps/{target_id}/clone-difficulty
body: { source_beatmap_id, source_difficulty, target_difficulty }
```

- `target_id` (path) is the target beatmap; `source_beatmap_id` (body) is the
  source. (The frontend invokes from the source row but the *target* is the
  chart being mutated, which reads naturally as the path resource.)
- Returns the service result dict on success.
- Error mapping: missing track/beatmap → 404; `CloneDifficultyError` → 422.
- Auth: match the existing beatmap-mutation endpoints on this router
  (`clone`, `activate`, `included`). Verify their dependency and apply the
  same one — do not invent a stricter guard that diverges from siblings.

### 3. Frontend — `web/frontend/src/pages/TracksPage.tsx`

A "Clone difficulty" control in each chart row's action area (alongside
Edit / Feedback). Clicking it opens a small picker scoped to that row's stem:

- **Source difficulty** — dropdown of the difficulties that actually exist in
  *this* (source) row's chart. Default: the row's highest difficulty present.
- **Target chart** — dropdown of the *other* charts on the same stem, labelled
  by their version/preset label (e.g. "V11 — chain playability").
- **Target difficulty** — dropdown of all four difficulty slots for the stem's
  section family (remap allowed).
- **Overwrite warning:** when the chosen target slot already has notes, show an
  inline warning ("This will overwrite V11's Hard difficulty") and the confirm
  button reads **Overwrite**. Empty slot → no warning, button reads **Clone**.
- On success: inline/toast confirmation and refresh the affected row(s) so
  difficulty badges reflect the new state.

Knowing which difficulties exist in each chart drives both the source dropdown
and the overwrite warning. The row already surfaces per-chart info; reuse the
existing per-beatmap stats/difficulty source the page has (the
`beatmaps/{id}/stats` endpoint exposes parsed sections) rather than adding a
new listing endpoint.

## Data flow

```
TracksPage row (source) → picker (source diff, target chart, target diff)
   → POST /beatmaps/{target}/clone-difficulty
   → clone_difficulty_across_beatmaps()
        read source notes.chart  → extract [source_difficulty] block
        (rescale ticks if resolution differs)
        read target notes.chart  → replace/insert [target_difficulty] block
        write target notes.chart
   → result dict → UI confirm + row refresh
```

## Error handling

| Condition | Result |
|---|---|
| Track or either beatmap not found | 404 |
| Source and target on different stems | 422 (`CloneDifficultyError`) |
| Source/target difficulty not in stem's section family | 422 |
| Source chart lacks the chosen source difficulty | 422 |
| `notes.chart` missing/unreadable on either side | 404/422 |
| Resolution unparseable | fall back to 1:1 (no rescale), proceed |

## Testing

- **Service unit tests** (`tests/`): same-stem same-resolution clone copies the
  block verbatim; cross-resolution clone rescales ticks correctly; remap
  (Expert→Hard slot) writes under the target name; overwrite reports
  `overwrote=True` and replaces only the target block (other sections
  byte-identical); empty target slot inserts and reports `overwrote=False`;
  cross-stem rejected; mismatched section family rejected; missing source
  difficulty rejected. Build chart fixtures inline (small `[Song]` +
  `[SyncTrack]` + a couple of difficulty blocks) — no audio needed.
- **Endpoint test:** happy path returns the result dict; 404 on unknown
  beatmap; 422 on cross-stem.
- Frontend: manual verification — the page has no test harness for this kind of
  interaction; rely on the typed picker + backend tests.

## Out of scope

- Tempo-aware re-timing across charts with different tempo maps.
- Cross-stem cloning (guitar notes into a drums section).
- Multi-difficulty / whole-chart clone (the existing whole-beatmap clone
  already covers the all-difficulties case).
- Any change to the publish-time `merge_beatmap_charts` flow — this edits a
  single beatmap's own `notes.chart` before publish.
