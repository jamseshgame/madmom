# Outreach → Reddit tracker — design

**Date:** 2026-07-08
**Author:** Jamsesh team (via Claude)
**Status:** Approved (interactive brainstorm)

## Goal

Give the whole team one place to see every VR / music-game / rhythm-game subreddit,
how big it is, whether we're allowed to post about our own game there (self-promotion
rules), its Discord invite, and to **track** where we've actually posted — so posts
don't get removed or get us banned.

## Decisions (from brainstorm)

- **Placement:** New `Outreach` top-nav page in the studio app (`/outreach`), with an
  internal subtab bar. **Reddit** is the first subtab (room for Discord/Twitter later).
- **Access:** Visible to **every signed-in team member** (not admin-only).
- **Data:** Reference table **plus** persistent per-subreddit tracking the team edits.
- **VR scope:** Broad — every VR-related subreddit (hardware, platforms, social, dev,
  VR rhythm games) plus all music-game and rhythm-game subs, plus promo-friendly
  indie-game subs where we're actually allowed to post.

## Data model

One row per subreddit. Reference fields come from research (baked seed); tracking
fields are team-editable and persisted.

Reference (seed, read-only in UI):
- `name` — e.g. `r/virtualreality`
- `url` — subreddit URL
- `category` — `VR-Rhythm` · `VR-Game` · `VR-Hardware` · `VR-Social` · `VR-Dev` ·
  `Rhythm-Game` · `Music-Game` · `Music-Community` · `Indie/Promo`
- `subscribers` — integer
- `subscribers_approx` — bool (estimate flag)
- `subscribers_as_of` — ISO date the count was captured
- `self_promo_verdict` — `Allowed` · `Limited` · `ModApproval` · `Banned` · `Unknown`
- `self_promo_detail` — 1-2 sentence summary of the actual rule/FAQ
- `discord` — invite URL or null

Tracking (team-editable, persisted):
- `status` — `Not posted` (default) · `Posted` · `Approved` · `Removed` · `Banned` ·
  `Awaiting mod`
- `last_posted` — ISO date or null
- `notes` — free text

Custom rows the team adds carry the same shape and a `custom: true` flag.

## Backend

New `outreach` router + service (`app/routers/outreach.py`, seed in
`app/services/outreach_reddit_seed.py`).

- **Seed list** — curated reference rows baked into the service from research,
  stamped `subscribers_as_of`.
- **Tracking overlay** — persisted to `<upload_dir>/outreach_reddit.json`, keyed by
  subreddit `name`: `{status, last_posted, notes}`. Custom-added rows stored in the
  same file under a `custom` list. Same load/save pattern as `generation_presets.json`.
- **Endpoints** (mounted in `main.py` behind `require_auth`, like the other routers):
  - `GET  /api/outreach/reddit` → seed ⊕ tracking merged rows
  - `PATCH /api/outreach/reddit/{name}` → update `status` / `last_posted` / `notes`
  - `POST /api/outreach/reddit` → add a custom subreddit
  - `DELETE /api/outreach/reddit/{name}` → remove a custom subreddit (seed rows can't
    be deleted, only their tracking reset)

`name` is URL-encoded in the path (contains `r/…`).

## Frontend

`web/frontend/src/pages/OutreachPage.tsx`:
- Subtab bar at top (`Reddit` active; disabled placeholders hint future channels).
- Sortable table — click a column header to toggle asc/desc; a sort indicator shows the
  active column. Sort helper is a small pure function so it can be unit-tested.
- Columns: Subreddit (link) · Category · Subscribers (with ~ when approx) · Self-promo
  (color chip) · Rule detail (truncated, expand on click) · Discord (join link) ·
  **Status** (dropdown) · **Last posted** (date input) · **Notes** (inline text).
- Color coding: verdict chips (green Allowed, yellow Limited, orange ModApproval,
  red Banned, gray Unknown); status chips similar.
- Filter/search box + category filter to cut the (large) list down.
- "Add subreddit" row for custom entries.
- Edits `PATCH` on change (debounced for notes); optimistic UI.

`App.tsx`: add `{ to: '/outreach', label: 'Outreach' }` to `baseNavItems` (no
`adminOnly`), and a `<Route path="/outreach" element={<OutreachPage />} />`.

## Testing

- Backend: merge (seed ⊕ tracking), PATCH persistence round-trip, custom add/delete,
  seed row can't be deleted. (`web/backend/tests/test_outreach_reddit.py`)
- Frontend: sort helper (numeric vs string columns, asc/desc, approx handling).
  (`web/frontend/src/chart/`… no — colocate near the page or in a `outreach` util
  module with a `.test.ts`.)

## Out of scope (YAGNI)

- No live subscriber refresh — counts are a stamped snapshot, re-researched on demand.
- No per-user attribution on tracking (team-shared single state is enough for now).
- No Discord/Twitter subtabs yet — just the shell that makes them easy to add.
