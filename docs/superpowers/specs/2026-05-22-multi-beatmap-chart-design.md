# Multi-beatmap-per-instrument chart format — design

Date: 2026-05-22
Status: Draft

## Problem

The publish-to-game flow at `tracks.py:1099` (`publish_track_to_game`) merges per-stem beatmaps into a single Clone Hero `notes_fixed_slides.chart`. Each stem contributes one beatmap — currently the active one (or the most recently generated if none is marked active). Other beatmaps for the same stem are stored on disk but never appear in the published chart.

With Project A's preset cog (`docs/superpowers/specs/2026-05-21-stem-result-preset-cog-design.md`) and Project B's V2 drum support (`docs/superpowers/specs/2026-05-21-v2-drum-support-design.md`), users can now easily generate many beatmaps per stem from different presets. The single-active-per-stem chart format leaves all but one of those beatmaps invisible to the game.

## Goal

Extend the published `.chart` format so every beatmap for a given stem appears in the chart as a distinct named section, allowing the Jamsesh game to surface alternates as picker options. Use sequential numbered sections (`[ExpertDrums]`, `[ExpertDrums2]`, `[ExpertDrums3]`, …) and a new `[Beatmaps]` metadata block that labels each section with its source preset.

**Non-goals:**
- Jamsesh game read-side support — game updates to parse `[Beatmaps]` and present alternates in the song-select UI. Tracked separately; this spec only changes the chart format.
- Frontend alternates picker — letting the user pick a subset of beatmaps to include. The current `selected_beatmaps` form field still controls which beatmap is the *primary* (unnumbered section); all other beatmaps for the same stem are automatically included as alternates.
- Per-beatmap display rename (e.g., "My Crunchy Drum Variant"). Currently the `[Beatmaps]` metadata uses the preset name. Custom display names are a follow-up.
- Clone Hero player support for alternates. Standard CH ignores unknown sections — the published chart stays Clone Hero-playable using the unnumbered (active) section only.

## Background

**Current per-stem merger** (`web/backend/app/services/chart_generator.py:87` `merge_beatmap_charts`):
- Accepts `list[tuple[chart_path, stem]]` — one beatmap per stem
- Maps each stem to a section suffix via `STEM_TO_SECTION_SUFFIX` (e.g., drums → `Drums`, guitar → `Single`)
- Renames `[ExpertSingle]`, `[HardSingle]`, `[MediumSingle]`, `[EasySingle]` from each input chart to `[Expert<suffix>]` etc.
- Emits one merged chart with `[Song]`, `[SyncTrack]`, `[Events]` from the first input + one set of difficulty sections per stem

**Current publish endpoint** (`web/backend/app/routers/tracks.py:1099` `publish_track_to_game`):
- Groups beatmaps by stem
- For each stem, picks one beatmap: the explicit `selected_beatmaps[stem]` if provided, else the active one, else the most recently generated
- Passes one chart per stem to `merge_beatmap_charts`

## High-level design

```
                     publish_track_to_game (modified)
                                │
                                ▼
                    gather ALL beatmaps per stem,
                    order them (active first, then
                    alphabetical by preset name), build
                    meta dicts {preset, beatmap_id, is_active}
                                │
                                ▼
                merge_beatmap_charts (modified signature)
                                │
                                ▼
                ┌───────────────┴───────────────────┐
                │ For each (chart_path, stem, meta) │
                │   - suffix from stem map           │
                │   - per-difficulty counter         │
                │     increments per stem            │
                │   - first per (diff,stem) gets     │
                │     unnumbered name, rest get N    │
                │     appended                       │
                │   - append row to [Beatmaps]       │
                └────────────────────────────────────┘
                                │
                                ▼
                    notes_fixed_slides.chart
                    (Clone Hero-compatible; unknown
                    sections silently ignored)
```

**Component diffs:**

| Path | Action |
|---|---|
| `web/backend/app/services/chart_generator.py` | Modify — extend `merge_beatmap_charts` signature, add numbering logic, emit `[Beatmaps]` block, add `_esc` helper |
| `web/backend/app/routers/tracks.py` | Modify — in `publish_track_to_game`, gather all beatmaps per stem, build per-beatmap meta dicts, pass through |
| `web/backend/tests/test_chart_merge_multi_beatmap.py` | Create — unit tests for the new merger behavior |
| `web/backend/tests/test_publish_track_to_game.py` | Create or extend — integration test for the full multi-beatmap publish flow |

## Chart format

The published chart gains numbered alternate sections plus a metadata block.

### Section header pattern

For each `(difficulty, stem-suffix)`, the N-th beatmap's section is:

```
n == 1  →  [<Difficulty><Suffix>]      (existing pattern, unnumbered)
n >= 2  →  [<Difficulty><Suffix>N]     (new)
```

Example for two stems with multiple beatmaps:

```
[Song] { ... }
[SyncTrack] { ... }
[Events] { ... }
[Beatmaps] { ... }

[ExpertSingle]    ← guitar beatmap #1 (active)
[HardSingle]
[MediumSingle]
[EasySingle]
[ExpertSingle2]   ← guitar beatmap #2 (alternate)
[HardSingle2]
[MediumSingle2]
[EasySingle2]
[ExpertSingle3]   ← guitar beatmap #3
...
[ExpertDrums]     ← drums beatmap #1 (active)
[HardDrums]
[MediumDrums]
[EasyDrums]
[ExpertDrums2]    ← drums beatmap #2
...
```

Note-track sections are grouped first by stem-suffix, then by `n`, then by difficulty (Expert→Hard→Medium→Easy). All four difficulties of a single beatmap stay adjacent in the file.

### `[Beatmaps]` metadata block

Inserted as the fourth header block, immediately after `[Events]` and before any note-track sections.

Each row describes one note-track section header that appears later in the file:

```
[Beatmaps]
{
  ExpertSingle = preset="v1" name="active" beatmap_id="ab12cd34"
  HardSingle = preset="v1" name="active" beatmap_id="ab12cd34"
  MediumSingle = preset="v1" name="active" beatmap_id="ab12cd34"
  EasySingle = preset="v1" name="active" beatmap_id="ab12cd34"
  ExpertSingle2 = preset="v3 — legacy global bins" name="alt" beatmap_id="ef56gh78"
  HardSingle2 = preset="v3 — legacy global bins" name="alt" beatmap_id="ef56gh78"
  MediumSingle2 = preset="v3 — legacy global bins" name="alt" beatmap_id="ef56gh78"
  EasySingle2 = preset="v3 — legacy global bins" name="alt" beatmap_id="ef56gh78"
  ExpertDrums = preset="drums-v1" name="active" beatmap_id="mn34op56"
  ...
}
```

**Row syntax:** `<SectionName> = preset="<preset>" name="<active|alt>" beatmap_id="<bid>"`

- `<SectionName>` — exact section header this row describes (e.g., `ExpertDrums2`). One row per `(difficulty, stem, n)` combination.
- `preset` — the V2 preset name that generated this beatmap. Empty string when no preset (legacy beatmap or hand-edited). Special value `"manual"` when the beatmap is marked as a manual edit.
- `name` — `"active"` for the unnumbered primary section, `"alt"` for numbered alternates. Lets game consumers distinguish the "default" chart from optional alternates.
- `beatmap_id` — Jamsesh beatmap record id. Lets tooling trace a chart section back to the source beatmap.

**String escaping:** double-quoted values escape `"` → `\"` and strip embedded newlines via a `_esc(s)` helper. Existing preset names are well-behaved; this is purely defensive.

**Why a line-per-section format:** matches the syntax Clone Hero uses for `[Events]` (`0 = E "..."`). A naive parser ("grab everything between `{` and `}`, split on `\n`, parse `key = value`") works without a JSON dependency.

## Merger changes

**File:** `web/backend/app/services/chart_generator.py`

**Signature change** — `merge_beatmap_charts`:

```python
# Before:
def merge_beatmap_charts(
    chart_paths_with_stems: list[tuple[str, str]],
    output_path: str,
) -> dict: ...

# After:
def merge_beatmap_charts(
    chart_paths_with_meta: list[tuple[str, str, dict]],
    output_path: str,
) -> dict: ...
```

Each item is `(chart_path, stem, meta)`. `meta` is `{'preset': str, 'beatmap_id': str, 'is_active': bool}`. The caller (publish endpoint) is responsible for ordering — `is_active=True` first per stem, then alphabetical by preset name.

**Numbering logic** (replaces the existing per-stem loop):

```python
# Counter tracks stem → next-beatmap-number-to-assign. All four
# difficulties for a single beatmap share the same N, so a beatmap
# missing one difficulty just leaves that specific section absent —
# its remaining difficulties still align at the beatmap's N.
beatmap_index_per_stem: dict[str, int] = {}
beatmaps_rows: list[str] = []
sections_out: list[tuple[str, str]] = []
included: list[str] = []
skipped: list[str] = []

for chart_path, stem, meta in chart_paths_with_meta:
    suffix = STEM_TO_SECTION_SUFFIX.get(stem)
    if suffix is None:
        skipped.append(stem); continue
    try:
        with open(chart_path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except OSError:
        skipped.append(stem); continue

    if song_block is None:
        # ... existing extraction of [Song]/[SyncTrack]/[Events] from first chart ...

    # Candidate N for this beatmap. Only committed to the counter
    # if at least one difficulty section actually emits — beatmaps
    # with zero usable sections don't burn a slot.
    candidate_n = beatmap_index_per_stem.get(stem, 0) + 1
    any_section = False
    preset = _esc(meta.get('preset', '') or '')
    bid = _esc(meta.get('beatmap_id', '') or '')
    name_tag = 'active' if meta.get('is_active') else 'alt'

    for difficulty in ('Expert', 'Hard', 'Medium', 'Easy'):
        m = re.search(
            r'\[' + difficulty + r'Single\]\s*\{([^}]*)\}',
            content,
        )
        if not m:
            continue
        section_name = (
            f'{difficulty}{suffix}' if candidate_n == 1
            else f'{difficulty}{suffix}{candidate_n}'
        )
        sections_out.append((section_name, m.group(1)))
        beatmaps_rows.append(
            f'  {section_name} = preset="{preset}" name="{name_tag}" beatmap_id="{bid}"'
        )
        any_section = True

    if any_section:
        beatmap_index_per_stem[stem] = candidate_n
        included.append(stem)
    else:
        skipped.append(stem)
```

**Output ordering** — sections are emitted grouped by `(stem-suffix, n, difficulty)`, so all four difficulties for a single beatmap stay adjacent in the file. Output order:

```
1. [Song]
2. [SyncTrack]
3. [Events]
4. [Beatmaps]          ← new
5. [ExpertSingle], [HardSingle], [MediumSingle], [EasySingle]  (guitar n=1)
6. [ExpertSingle2], [HardSingle2], [MediumSingle2], [EasySingle2]  (guitar n=2)
   ... etc.
7. [ExpertDrums], [HardDrums], [MediumDrums], [EasyDrums]  (drums n=1)
8. [ExpertDrums2], ...
```

The existing implementation emits sections in input order; the new implementation sorts before writing.

**`_esc` helper:**

```python
def _esc(s: str) -> str:
    """Escape a string for use inside a [Beatmaps] row's double-quoted value.
    
    Strips newlines (which would corrupt the line-oriented row format) and
    escapes embedded double quotes."""
    return s.replace('\r', '').replace('\n', ' ').replace('"', '\\"')
```

## Publish endpoint changes

**File:** `web/backend/app/routers/tracks.py` `publish_track_to_game`

Replace the per-stem single-beatmap selection (currently `tracks.py:1196-1230`) with a per-stem ordered-list gather:

```python
charts_to_merge: list[tuple[str, str, dict]] = []
beatmap_selection: dict[str, str] = {}
for stem, candidates in by_stem.items():
    # Pick the primary (unnumbered) beatmap for this stem:
    #   - explicit override from selected_beatmaps wins
    #   - else the user-marked active one
    #   - else the most recently generated
    primary: dict | None = None
    want = stem_overrides.get(stem)
    if want:
        primary = next((b for b in candidates if b.get('id') == want), None)
    if primary is None:
        primary = next((b for b in candidates if b.get('active')), None)
    if primary is None:
        primary = max(candidates, key=lambda b: b.get('generated_at', 0))

    # All other beatmaps for this stem become alternates, sorted alphabetically
    # by preset name so the chart section numbering is stable across reruns
    # (a specific preset always lands in the same [DrumsN] slot).
    alternates = sorted(
        (b for b in candidates if b is not primary),
        key=lambda b: (b.get('preset', '') or '', b.get('generated_at', 0)),
    )

    for i, bm in enumerate([primary] + alternates):
        bm_dir = track.beatmaps_dir / bm.get('id', '')
        if not bm_dir.exists():
            continue
        src_chart = None
        for candidate in ('notes.chart', 'notes_fixed_slides.chart'):
            p = bm_dir / candidate
            if p.exists():
                src_chart = p
                break
        if src_chart is None:
            src_chart = next(iter(bm_dir.glob('*.chart')), None)
        if src_chart is None:
            continue
        meta = {
            'preset': bm.get('preset', '') or '',
            'beatmap_id': bm.get('id', ''),
            'is_active': i == 0,
        }
        charts_to_merge.append((str(src_chart), stem, meta))
    beatmap_selection[stem] = primary.get('id', '')
```

The downstream `merge_beatmap_charts` call is unchanged at the call site — it just receives the wider tuple shape.

## Edge cases

| Scenario | Behavior |
|---|---|
| Stem has zero beatmaps | Not included in `charts_to_merge`; no sections emitted for that stem (unchanged) |
| Stem has one beatmap | Emits unnumbered `[ExpertSingle]` etc.; `[Beatmaps]` has 4 rows for that stem with `name="active"`. No alternates. |
| Beatmap chart file missing on disk | Skipped during gather (the `if src_chart is None: continue` guard). No row in `[Beatmaps]` for it. Other beatmaps for the same stem still publish. The next beatmap's numbering increments normally — there's no gap because the counter only advances when a section actually emits. |
| Beatmap is missing one difficulty section (e.g., `[MediumSingle]` absent) | That specific section is simply absent from the output (e.g., the chart has `[ExpertSingle2]`, `[HardSingle2]`, `[EasySingle2]` but no `[MediumSingle2]`). The beatmap still advances the per-stem counter, so the *next* beatmap's all-four-diffs cleanly land at the next N. The `[Beatmaps]` block has 3 rows for this beatmap (no row for the missing difficulty) — a consumer can detect the gap by noting a row is absent for an expected section name. |
| Beatmap chart is missing all four difficulty sections | The candidate N is not committed to the counter (the `if any_section:` guard). The beatmap is added to `skipped`, no rows in `[Beatmaps]`, no sections in the chart. Other beatmaps for the same stem still publish; the next beatmap reuses the candidate N. |
| Preset name contains `"` or `\n` | `_esc()` escapes/strips. Defensive — existing preset names are clean. |
| Preset field on the beatmap is empty | `[Beatmaps]` row emits `preset=""`. Game can fall back to displaying the section name. |
| Two beatmaps with the same preset name (e.g., user generated v3 twice) | Both are ordered by `(preset, generated_at)` — same preset name → ordered by generation time. Both land in alternates with the same preset string in the `[Beatmaps]` row. Acceptable; users can disambiguate by `beatmap_id`. |

## Backwards compatibility

- **Clone Hero** ignores unknown sections. A published chart from this change is still playable in Clone Hero — players get the unnumbered (active) section only, exactly as today.
- **Existing Jamsesh game build** ignores `[Beatmaps]` and the numbered sections (same parser behavior as Clone Hero). It plays the active beatmap exactly as today.
- **Future Jamsesh game build** (out of scope) will parse `[Beatmaps]` and present a picker.
- **Chart files already on GitHub** are not re-published by this change. Republishing a track after this change ships will replace the chart with the multi-beatmap version.

## Error handling

| Scenario | Backend response |
|---|---|
| All beatmaps for a stem have missing chart files | Stem ends up in the `skipped` list of `merge_beatmap_charts`. The publish flow logs a warning; the rest of the publish proceeds. Existing behavior. |
| `[Beatmaps]` would be empty (no beatmaps at all) | Don't emit the section. (Backwards-compat: a no-beatmap chart looks like one without the new section.) |
| `_esc` collapses a multi-line preset name to one line | Information loss is acceptable — the chart is single-line per row and the original preset name is still stored on the beatmap record. |
| Number of alternates per stem > arbitrary high limit (say >50) | No hard limit. Chart file grows linearly. Users uploading thousands of alternates would notice GitHub commit size limits before the chart parser caused issues. |

## Testing

**Backend unit tests** — `web/backend/tests/test_chart_merge_multi_beatmap.py` (new):

- `test_single_beatmap_single_stem` — one stem, one beatmap → unnumbered sections; `[Beatmaps]` has 4 rows with `name="active"`
- `test_three_beatmaps_one_stem_alphabetical_order` — three beatmaps for guitar with presets ['v3', 'v1', 'v2'], active=v1 → primary=v1 unnumbered, alternates v2 → [Single2], v3 → [Single3]
- `test_two_stems_grouped_in_file_order` — drums + guitar, two beatmaps each → sections grouped by stem-suffix then n then difficulty
- `test_missing_difficulty_section_does_not_block_others` — beatmap with no `[MediumSingle]` → its Expert/Hard/Easy land at the same `n` as each other; `[MediumSingle{n}]` simply absent; the next beatmap's four difficulties cleanly land at `n+1`
- `test_all_missing_difficulties_does_not_burn_n_slot` — three beatmaps where beatmap #2 has no difficulty sections at all → beatmap #1 lands at n=1, beatmap #2 skipped entirely, beatmap #3 lands at n=2 (not n=3)
- `test_beatmaps_block_escapes_quote_and_newline` — preset name `'has "quote" and\nnewline'` → row contains `\"quote\"` and ` ` (newline collapsed to space)
- `test_empty_beatmaps_list_does_not_emit_section` — call with empty input → returned chart has no `[Beatmaps]` block, no included stems
- `test_stem_with_no_section_mapping_skipped` — call with `stem='other'` (not in STEM_TO_SECTION_SUFFIX) → skipped list contains 'other', no sections for it

**Backend integration test** — `web/backend/tests/test_publish_track_to_game.py` (new or extend existing):

- `test_publish_includes_all_beatmaps_for_stem` — track with 3 drums beatmaps, no `selected_beatmaps` override → published chart contains `[ExpertDrums]`, `[ExpertDrums2]`, `[ExpertDrums3]` + `[Beatmaps]` block with 12 rows
- `test_publish_respects_selected_beatmaps_override` — track with 3 drums beatmaps, `selected_beatmaps={"drums": "<id-of-second-beatmap>"}` → the override beatmap is in `[ExpertDrums]` (active); the other two are alternates
- `test_publish_orders_alternates_alphabetically_by_preset` — 4 drums beatmaps with presets ['v3', 'drums-v1', 'v1', 'v2'], active=v1 → alternates are [drums-v1, v2, v3] in that order

**Manual smoke** (Clone Hero compatibility):

- [ ] Take a published chart with alternates and drop it into a Clone Hero install. Confirm the song loads and the active difficulty plays normally.
- [ ] Visually inspect a published `notes.chart` file (`grep -E '^\[' notes_fixed_slides.chart`) and confirm the section ordering matches the spec.

## Deployment

Backend-only change (chart merger + publish endpoint). Per the deploy memory:

```
ssh beatmap 'cd /opt/madmom && git pull --ff-only && systemctl restart beatmap-backend'
```

No `npm run build` needed. No new pip dependencies.

## Open follow-ups

- **Jamsesh game read-side support** — game needs to parse `[Beatmaps]` and offer alternates in the song-select UI. Tracked separately as a game-engine project.
- **UI alternates picker** — if users want explicit control over which beatmaps publish (not all), `selected_beatmaps` form field can grow to `{stem: {primary: id, alternates: [ids...]}}` without breaking compatibility. Defer.
- **Per-beatmap display name** — currently the `name` column in `[Beatmaps]` is just `"active"`/`"alt"`. Adding a `display_name` field on the beatmap record + surfacing it as a new column in `[Beatmaps]` would let users author custom alternate labels ("Crunchy Variant", "Soft Mix"). Defer until users ask.
- **Republish notifier** — after this change ships, all existing published charts on GitHub are still the old single-beatmap format. A button to bulk-republish a track collection would let users upgrade existing charts. Out of scope.
- **`[Beatmaps]` schema versioning** — if the row format ever changes (new columns, different escaping), consumers need to know the schema version. A leading `version = 1` row could be added, or a `# version 1` comment. Defer until the schema actually needs to change.
