import { VersionsTable } from '../components/VersionStatus.tsx'
import { STUDIO_VERSION } from '../version.ts'

type Entry = { kind: 'added' | 'changed' | 'fixed'; text: string }
type Release = {
  version: string
  date: string
  summary?: string
  entries: Entry[]
}

const RELEASES: Release[] = [
  {
    version: '1.6.7',
    date: '2026-04-29',
    summary:
      'Tutorial sidebar checkbox is pre-ticked when the chart was authored as a tutorial — no more clicking enabled before adding the first VO.',
    entries: [
      { kind: 'fixed', text: 'Editor sidebar Tutorial → enabled was only flipped on when the chart carried at least one parsed VO/STEP/MUSIC event. Charts created via Create blank tutorial / Open empty editor (tutorial=true) ship with an empty [TutorialScript] {} block, so the box stayed off and the user had to tick it before authoring. Now any non-empty OR empty [TutorialScript] section in the chart pre-flips the checkbox on.' },
    ],
  },
  {
    version: '1.6.6',
    date: '2026-04-29',
    summary:
      'Open the beatmap editor on a track that has no beatmap yet — without first running auto chart generation.',
    entries: [
      { kind: 'added', text: 'Stem cards on the track detail view now show an "or open empty editor →" link when there are no beatmaps for that stem yet. One click creates a beatmap with an empty notes.chart (just [Song]/[SyncTrack] with the chosen BPM, empty [Events] and [ExpertSingle]) and lands you in /edit/<track>/<beatmap>.' },
      { kind: 'added', text: 'Same option as a secondary button in the advanced settings (⚙) modal alongside Generate Beatmap.' },
      { kind: 'added', text: 'Backend POST /api/tracks/:id/empty-beatmap form fields stem (default guitar), bpm (default 120), tutorial (bool). Reuses the requested stem\'s audio as the beatmap\'s song.ogg, transcoding to OGG when needed. The new beatmap appears as a chip on the stem card immediately.' },
    ],
  },
  {
    version: '1.6.5',
    date: '2026-04-29',
    summary:
      'Upgrade buttons on the dependency table — pip install --upgrade in the backend, then schedule a service restart, all from the Changelog page.',
    entries: [
      { kind: 'added', text: 'Every outdated row in the Open-source dependencies table now carries an Upgrade button. Click → confirm modal explains what will run; confirm → backend creates a Job that streams pip install --upgrade <pkg> through SSE; the modal renders live progress + the latest pip output line.' },
      { kind: 'added', text: 'On a successful upgrade the modal offers a Restart backend now button. The endpoint schedules a detached systemctl restart beatmap-backend (with a 1s sleep so the response can land) and the frontend polls /api/health every 1.5s, refreshing the table once the service is back.' },
      { kind: 'changed', text: 'madmom is marked pinned in PACKAGES (it is installed via pip install -e ../../ as your local fork) — the table shows a "pinned" tag on the status pill and hides the Upgrade button so a click cannot clobber the local checkout. Upgrade those manually via SSH if needed.' },
      { kind: 'added', text: 'Backend POST /api/versions/:package/upgrade and POST /api/versions/restart-backend. Both check the package against the PACKAGES allow-list and refuse pinned entries.' },
    ],
  },
  {
    version: '1.6.4',
    date: '2026-04-29',
    summary:
      'Open-source dependencies table on the Changelog page — every package, installed vs PyPI latest, license, and what we use it for.',
    entries: [
      { kind: 'added', text: 'Changelog page now opens with a live Open-source dependencies table covering madmom, demucs, chatterbox-tts, yt-dlp, torch / torchaudio / torchcodec, Pillow, fastapi, uvicorn, httpx, numpy, scipy. Each row pings PyPI for the latest release and renders Up to date / Update available / PyPI unreachable accordingly. Package names link to the PyPI page.' },
      { kind: 'changed', text: 'Backend /api/versions returns a packages[] array driven by a single PACKAGES list in routers/versions.py — to track another dep, add one row there. Legacy madmom / demucs top-level keys retained so the existing VersionBanner keeps working.' },
      { kind: 'changed', text: 'Footer no longer prints the madmom / demucs version line — it lived next to the Changelog link and duplicated info that now belongs to the dependencies table. Footer just links to "Changelog & dependencies" instead.' },
    ],
  },
  {
    version: '1.6.3',
    date: '2026-04-29',
    summary:
      'Zoomable timeline strip in the editor header — every VO / STEP / MUSIC event as a colour-coded draggable block over the full song duration.',
    entries: [
      { kind: 'added', text: 'Editor header now hosts a full-song timeline filling the empty space between the title and Save. VO events render as cyan tick marks with a ▶ pill, STEP as purple ticks with a ⚑ pill, MUSIC as orange bands stretched across the segment\'s clip duration. Click anywhere on the strip to seek; the runway scrolls to that moment.' },
      { kind: 'added', text: 'Wheel zooms (around the cursor); Shift+wheel pans. Click+drag the strip background to scrub. Click+drag a block to reposition its tick — snap is the same beat fraction the runway uses (1/4, 1/8, 1/16, 1/32 selected in the sidebar).' },
      { kind: 'added', text: 'Beat grid drawn under the blocks; bar lines (every 4 beats) are stronger than beat lines. Time labels (m:ss) along the top adapt their stride to the current zoom so they don\'t overlap.' },
      { kind: 'changed', text: 'Editor header height grew from 56px to 80px to fit the timeline. Title block compacted to a fixed 176px to leave maximum room for the strip.' },
    ],
  },
  {
    version: '1.6.2',
    date: '2026-04-29',
    summary:
      'Music segments — drop a short clip at any timestamp, the chart generator runs on it, and you get a self-contained mini-lesson with pass/fail.',
    entries: [
      { kind: 'added', text: 'New + MUSIC button next to + VO and + STEP in the editor sidebar. Opens a modal that uploads a clip (any audio format), runs generate_full_chart on it, and stitches a MUSIC event into [TutorialScript] plus a [MusicSeg_<id>] block of generated notes into the same chart. Pass/fail uses the same required / timing / retry_vo / next fields as STEP.' },
      { kind: 'added', text: 'Backend POST /api/tutorial/:track/beatmaps/:bm/music-segment — saves the upload under <beatmap>/segments/<id>.ogg, transcodes non-OGG inputs via ffmpeg, runs the existing chart generator, returns the chosen difficulty section verbatim plus the segment\'s native BPM, resolution, duration and note count. 5-minute hard cap.' },
      { kind: 'added', text: 'Editor canvas renders music segments as orange bands spanning the clip duration with file name + note count + BPM + pass criteria stamped on the band. Saves round-trip the [MusicSeg_*] sections so segment notes survive across difficulty switches and re-saves.' },
      { kind: 'added', text: 'Per-segment audio preview directly in the sidebar event row. Delete on the row also DELETEs the OGG on disk best-effort.' },
      { kind: 'added', text: 'Tutorial spec (web/docs/TUTORIAL_SPEC.md) gains a MUSIC section documenting the line grammar, segment-section layout, and recommended runtime behaviour for the Unity dev — same execution model as STEP, just with embedded clip audio + notes.' },
    ],
  },
  {
    version: '1.6.1',
    date: '2026-04-29',
    summary:
      'Create a fresh tutorial straight from the home page — no audio file or stem separation required.',
    entries: [
      { kind: 'added', text: 'Create a blank tutorial — no audio file link sits below the stems-only fallback on Studio Library home. Modal asks for title, charter, BPM (40–240) and duration (30–1800 s) and POSTs to the new /api/tracks/blank-tutorial endpoint.' },
      { kind: 'added', text: 'Backend POST /api/tracks/blank-tutorial uses ffmpeg lavfi anullsrc to synthesise a silent OGG of the requested length, persists it as a Track + a single beatmap whose notes.chart already includes empty [Events] / [ExpertSingle] / [TutorialScript] sections and a SyncTrack with the chosen BPM. song.ini gets [tutorial] tutorial=True at the start.' },
      { kind: 'added', text: 'On submit the user is navigated straight to /edit/<track>/<beatmap> — tutorial mode is already on and the runway is empty so they can drop VOs / STEPs and generate TTS without going through stem separation.' },
    ],
  },
  {
    version: '1.6',
    date: '2026-04-28',
    summary:
      'Tutorial mode — VO + step events on the runway, voice-cloning TTS via Chatterbox, 10 instrument samples per track with auto slide_up/slide_down variants, and a [TutorialScript] section in the published chart.',
    entries: [
      { kind: 'added', text: 'Tutorial mode toggle in the BeatmapEditor sidebar. Adds two new event types to the chart: VO (timestamped narration playback) and STEP (pass/fail boundary with required notes, timing strictness, retry VO, and next-step pointer). Both serialise into a new [TutorialScript] section that backwards-compatible engines just ignore.' },
      { kind: 'added', text: 'Per-VO Generate button calls the new /api/tutorial/tts/synth endpoint. The backend uses Chatterbox (Resemble AI, MIT) to produce a voice-cloned OGG from the typed script, persisted under the beatmap\'s vo/ directory and served back via /api/tutorial/:track/beatmaps/:bm/vo/:name.' },
      { kind: 'added', text: 'Track detail view gains a Tutorial samples + voice clone panel with 10 instrument-sample slots (lane 1-5, chord 12/23/34/45, open) and an upload zone for a 5-30s voice reference clip. Anything non-OGG is transcoded with ffmpeg on save.' },
      { kind: 'added', text: 'Editor runway draws STEP boundaries as faint horizontal stripes with id/required/timing labels and VOs as dashed cyan lines with a ▶ glyph. Playhead "+ VO at <time>" / "+ STEP" buttons drop new events at the current playhead, snapped to the active grid.' },
      { kind: 'added', text: 'Publish to Game extracts [TutorialScript] from each selected beatmap, copies the track\'s tutorial_samples/ + each beatmap\'s vo/ clips into the published folder, and synthesises slide_up / slide_down (±2 semitones) variants of every sample with ffmpeg asetrate. song.ini grows a [tutorial] section with tutorial=True + sample_<slot> paths so the Unity dev can resolve assets.' },
      { kind: 'added', text: 'Backend endpoints: POST /api/tutorial/tts/synth, GET/POST/DELETE /api/tutorial/:track/voice-ref, GET/PUT/DELETE /api/tutorial/:track/samples/:slot, GET /api/tutorial/:track/beatmaps/:bm/vo/:name. The TTS model lazy-loads on first call; ~3 GB download + ~3 GB resident.' },
    ],
  },
  {
    version: '1.5.3',
    date: '2026-04-28',
    summary:
      'Beatmap-editor runway is now centred at a fixed-ish width by default instead of stretching across the entire viewport.',
    entries: [
      { kind: 'changed', text: 'Beatmap editor runway capped at 420px and centred horizontally inside the canvas pane. Lanes sit at a comfortable density on a 27" monitor without having to squeeze the window. The ResizeObserver tracks the inner container so the canvas backing store still matches actual rendered pixels.' },
    ],
  },
  {
    version: '1.5.2',
    date: '2026-04-28',
    summary:
      'Pick which beatmap takes ship in notes_fixed_slides.chart when a track has multiple beatmaps for the same stem.',
    entries: [
      { kind: 'added', text: 'Publish to Game now shows a "beatmaps merged into the published chart" panel listing every stem with at least one beatmap. Stems with multiple beatmaps render as a dropdown of available takes (newest first), defaulting to the most recent. Stems with one beatmap render as a static label.' },
      { kind: 'added', text: 'The publish endpoint accepts a `selected_beatmaps` JSON form field — `{ "drums": "<beatmap_id>", "guitar": "<beatmap_id>" }` — and uses it to override the per-stem selection. Anything missing or empty falls back to the previous "latest per stem" behaviour, so existing publish flows keep working.' },
      { kind: 'changed', text: 'Publish-result panel reports the chosen beatmap_id per stem under `chart.selected_beatmaps`.' },
    ],
  },
  {
    version: '1.5.1',
    date: '2026-04-28',
    summary:
      'Rename finished beatmaps from the stats modal — handy when a track has multiple beatmaps for the same stem.',
    entries: [
      { kind: 'added', text: 'Click the song-name line in the beatmap stats modal to rename a finished beatmap. Saves through the new PATCH /api/tracks/:trackId/beatmaps/:beatmapId endpoint, which updates the track.json record and rewrites the [Song] name in the beatmap\'s song.ini and notes.chart so the new title propagates into anything downstream that reads either file.' },
      { kind: 'changed', text: 'Stem-card beatmap chips now show the custom song name when one is set, falling back to the generation date otherwise. Hover tooltip carries both name and date.' },
    ],
  },
  {
    version: '1.5',
    date: '2026-04-28',
    summary:
      'Multi-instrument charts on publish (drums + guitar + bass in one notes_fixed_slides.chart), tighter difficulty staircase, and an octave-error guard on beat detection.',
    entries: [
      { kind: 'fixed', text: 'Publish to Game now merges every beatmap on the track into a single notes_fixed_slides.chart instead of shipping just the most recent one. Each per-stem beatmap is renamed into the correct Clone Hero section based on its source stem (guitar → [*Single], drums → [*Drums], bass → [*DoubleBass], piano → [*Keyboard]). Vocals and "other" stems are skipped from the merged chart. Old beatmaps already on a track work as-is.' },
      { kind: 'fixed', text: 'Easy / Medium / Hard difficulties were as note-dense as Expert because every difficulty was fed the same onset list. Each tier now applies a min-onset-gap filter (Hard 0.20s, Medium 0.35s, Easy 0.55s) so the density actually scales — Easy ends up at roughly one note per beat instead of four.' },
      { kind: 'fixed', text: 'Beat-tracker octave errors on weak-transient stems (sustained guitar chords are the canonical case) are now caught: any detected BPM under 70 is doubled, anything over 200 is halved. The progress log says "snapped from X" when a correction fires so you can spot it in the event log.' },
      { kind: 'changed', text: 'Publish result panel reports which stems contributed to the merged chart and which were skipped, so you can see at a glance whether drums actually made it in.' },
    ],
  },
  {
    version: '1.4',
    date: '2026-04-28',
    summary:
      'Search YouTube and pull a track straight into the separation flow — no more downloading, converting, and dragging files in by hand.',
    entries: [
      { kind: 'added', text: 'YouTube search bar above the upload dropzone. Type artist + title, get the top 10 results with thumbnails, channel and duration. Click a result and the backend downloads the audio with yt-dlp, extracts a 320 kbps MP3 with ffmpeg, and feeds it straight into the separation flow as if you had dragged it in by hand.' },
      { kind: 'added', text: 'YouTube downloads are tracked as Jobs (kind: youtube), so progress streams through the same SSE infrastructure as separations and survives a tab close — and the auto-delete TTL cleans up the temporary MP3 once it has been promoted into a Track.' },
      { kind: 'added', text: 'Backend endpoints: GET /api/youtube/search, POST /api/youtube/download (returns job_id), GET /api/youtube/{id}/file (the MP3 once the job is done). Hard cap of 30 minutes per video to keep disk and CPU bounded.' },
    ],
  },
  {
    version: '1.3.4',
    date: '2026-04-28',
    summary:
      'Publish to Game now writes the chart as notes_fixed_slides.chart — the filename the Jamsesh game expects.',
    entries: [
      { kind: 'changed', text: 'Publish to Game writes the chart file as notes_fixed_slides.chart in the published folder regardless of the source filename inside the beatmap directory. v1.2.3 was renaming everything to notes.chart, but the Jamsesh game expects the legacy fixed-slides filename — songs published before this release need to be re-published.' },
      { kind: 'changed', text: 'Source-file precedence for the publish copy: notes.chart → notes_fixed_slides.chart → first *.chart found. The publish-result panel now reports both the source name and the published name when they differ.' },
    ],
  },
  {
    version: '1.3.3',
    date: '2026-04-28',
    summary:
      'Stem cards in the Studio Library detail collapse to a single button row: Generate Beatmap + advanced settings cog. Download moved into the cog modal.',
    entries: [
      { kind: 'changed', text: 'Per-stem Download button moved out of the main stem card and into the advanced settings modal (opened via the ⚙ cog) as a "Download stem" action in the modal header. Generate Beatmap and the cog now share a single tidy row beneath the stem player.' },
      { kind: 'changed', text: 'Master Mix cards keep the Download button on the card itself — there is no Generate Beatmap option for the master, so no settings modal to nest it under.' },
    ],
  },
  {
    version: '1.3.2',
    date: '2026-04-28',
    summary:
      'Publish to Game preview line now shows the full file list correctly — including notes.chart and album.png — and stops listing fake song_ini.ogg / album_png.ogg entries.',
    entries: [
      { kind: 'fixed', text: 'Publish to Game preview was iterating every key in track.stems and slapping .ogg on the end. song_ini and album_png are bookkeeping keys, not audio — so the preview was promising song_ini.ogg and album_png.ogg files that never existed. Filtered them out (and song.ogg, which is appended explicitly).' },
      { kind: 'added', text: 'Preview now lists notes.chart in green when the track has a beatmap, and shows an amber "⚠ no notes.chart" warning when it doesn\'t — surfacing the same check before publish that v1.2.3 added after.' },
      { kind: 'added', text: 'album.png appears in the preview when the track has cover art, so the published file list matches reality.' },
    ],
  },
  {
    version: '1.3.1',
    date: '2026-04-28',
    summary:
      'Hotfix — saving metadata after adding album art was wiping the art reference from the track.',
    entries: [
      { kind: 'fixed', text: 'PATCH /api/tracks/:id/song-ini was writing album.png to disk but losing the in-memory stems-dict mutation that points track.json at it. update_track_meta() did a fresh Track.load() that overwrote the local instance, so library rows came back with no art reference even though the file was sitting on disk. The PATCH handler now mutates one Track instance and saves it once.' },
    ],
  },
  {
    version: '1.3',
    date: '2026-04-28',
    summary:
      'One-click beatmap generation from the Studio Library, batch generation across multiple stems, and 5-lane drums on by default.',
    entries: [
      { kind: 'added', text: 'One-click "Generate Beatmap" button on every non-master stem card in the Studio Library detail view. Uses the track\'s current name / artist / album / genre / year — no modal, no settings dance — and shows inline progress with a Kill button right under the stem player.' },
      { kind: 'added', text: 'A settings cog (⚙) sits next to the Generate button and opens the existing advanced song.ini panel for cases where you need to tweak per-difficulty ratings, HOPO frequency, or other gameplay flags.' },
      { kind: 'added', text: 'Tickbox on each non-master stem card plus a "Generate beatmap for N stems" button below the grid. Queues up parallel beatmap generations across whichever stems you ticked — pick drums + guitar + bass and walk away.' },
      { kind: 'changed', text: 'five_lane_drums now defaults to true in the song.ini schema and the /generate-beatmap endpoint. Quick-generate explicitly sets it for drums stems so the default is sticky regardless of any future schema change.' },
    ],
  },
  {
    version: '1.2.5',
    date: '2026-04-28',
    summary:
      'Fixes a regression where the post-separation result view was rendering a blank panel — no track title, no stem cards, no Generate Beatmap buttons. Plus an Auto-fetch cover art button driven off the typed name + artist.',
    entries: [
      { kind: 'fixed', text: 'Stem separation result view now actually shows the stems. The backend was emitting a "step: done" event at 95% as an in-progress milestone ("Stems ready: …"), which the SSE consumer mistook for the terminal event and closed the connection before the real send_done() arrived. Renamed the milestone step to "finalize"; ProgressTracker also now requires metadata before treating "done" as terminal.' },
      { kind: 'added', text: 'Auto-fetch from name + artist button next to the album.png picker on both the post-separation result view and the Studio Library track detail. Hits iTunes Search, falls back to MusicBrainz / Cover Art Archive, and stages the resulting 512×512 PNG for save.' },
      { kind: 'added', text: 'Backend POST /api/beatmap/cover-art-search endpoint — accepts artist/title/album form fields and returns a 512×512 PNG (or 204 if no match).' },
      { kind: 'added', text: 'Result view now falls back to the upload filename for name + artist when the audio file had no embedded title/artist tags. "Artist - Track Name.mp3" splits into both fields; otherwise the whole filename becomes the name.' },
    ],
  },
  {
    version: '1.2.4',
    date: '2026-04-28',
    summary:
      'Failed and cancelled jobs can be deleted from the Studio Library. The ghost rows used to be unremovable until the cleanup loop swept them away an hour later.',
    entries: [
      { kind: 'added', text: 'Delete button on every non-active job ghost row in Studio Library. One click removes the job from the in-memory store, deletes the persisted JSON, and nukes its transient upload directory.' },
      { kind: 'added', text: 'Backend DELETE /api/jobs/:id endpoint. Refuses to delete a queued/running job (cancel first) so a click never silently kills work in flight.' },
    ],
  },
  {
    version: '1.2.3',
    date: '2026-04-28',
    summary:
      'Publish to Game now actually includes the chart file. The published folder used to ship stems + song.ini + song.ogg + album.png with no beatmap, leaving the song unplayable in-game.',
    entries: [
      { kind: 'fixed', text: 'Publish to Game now copies notes.chart from the latest beatmap on the track into the published folder. Falls back to any *.chart file in the beatmap dir, so legacy generator outputs (notes_fixed_slides.chart from bin/JamseshMenu) get picked up too.' },
      { kind: 'added', text: 'Publish result panel reports whether a chart was included and where it came from. Shows a yellow warning if the track has no beatmap, telling the user to generate one and re-publish.' },
    ],
  },
  {
    version: '1.2.2',
    date: '2026-04-28',
    summary:
      'Hotfix — separations were crashing at the final stem-write step because torchaudio 2.11 dispatches save() through torchcodec, which was not installed. Pinned torchcodec in requirements.txt.',
    entries: [
      { kind: 'fixed', text: 'Demucs separation no longer crashes with "TorchCodec is required for save_with_torchcodec" at the final write. torchaudio >= 2.5 routes save()/load() through the torchcodec C++/FFmpeg backend; demucs 4.x still calls torchaudio.save() to write WAVs, so torchcodec must be present or every separation fails after burning the full inference cost.' },
      { kind: 'changed', text: 'Backend requirements.txt now lists torchcodec explicitly with a comment explaining why, so a fresh deploy from scratch picks it up.' },
    ],
  },
  {
    version: '1.2.1',
    date: '2026-04-28',
    summary:
      'Demucs separations are roughly 5× faster by default. The shifts slider used to default to 10 (Best) which ran 10 full inference passes per song; the quality plateau for music stems is around 2 passes, so that is the new default.',
    entries: [
      { kind: 'changed', text: 'Default Quality (shifts) lowered from 10 to 2. A 4-minute song that took ~30 minutes to separate now takes ~6 minutes on the production droplet, with no audible difference for game stems. Slider still goes up to 10 for power users.' },
      { kind: 'changed', text: 'Default overlap lowered from 0.5 to 0.25 (the Demucs default) — slightly faster, no perceptible quality loss.' },
      { kind: 'changed', text: 'Quality slider hint now describes each shift count instead of the generic Fast/Balanced/Best buckets.' },
      { kind: 'added', text: 'Job event log entries now carry a `ts` field with wall-clock time, so per-pass timing can be reconstructed from the persisted JSON to diagnose any future "is it slowing down?" reports.' },
    ],
  },
  {
    version: '1.2',
    date: '2026-04-28',
    summary:
      'Jobs are now persisted, resumable, and listed in the Studio Library. Close the tab during a long separation and the URL ?job=<id> reattaches you to the live progress on any machine.',
    entries: [
      { kind: 'added', text: 'Each running task pins itself to the URL as ?job=<id>. Reload, copy the URL to another browser, or hand it to a teammate — they pick up the live progress and full event log instead of starting over.' },
      { kind: 'added', text: 'Studio Library now shows a ghost row for every active or recently failed separation, with a status pill (Queued / Running / Failed / Cancelled) and the latest log line. Click the row to open the live progress view.' },
      { kind: 'added', text: 'Backend persists every job to disk (`<upload_dir>/jobs/<id>.json`) on every event. A backend restart restores the records — running jobs at the time of restart are flipped to Failed with a clear reason rather than silently disappearing.' },
      { kind: 'added', text: 'New universal jobs API: GET /api/jobs (list), GET /api/jobs/:id (snapshot + last 200 events), GET /api/jobs/:id/events (SSE replay), POST /api/jobs/:id/cancel.' },
      { kind: 'changed', text: 'SSE subscribers now receive the full event log on connect instead of only future events, so a refreshed tab sees the same demucs log lines from the start.' },
      { kind: 'changed', text: 'Job records carry a kind (separate / manual_stems / beatmap) and a human-readable title so the library row reads "Artist — Track" instead of an opaque ID.' },
    ],
  },
  {
    version: '1.1',
    date: '2026-04-27',
    summary:
      'Beatmap editor is now a full-page workspace with difficulty switching, drag-to-move with BPM snap, and drum-kit lane labels.',
    entries: [
      { kind: 'changed', text: 'Beatmap editor is now a dedicated full-page route at /edit/:trackId/:beatmapId — the runway maximises to fill the viewport on the left, with all controls collected into a sidebar on the right.' },
      { kind: 'added', text: 'Difficulty dropdown in the editor sidebar — switch between every editable [*Single] / [*Drums] section in the chart. In-memory edits are kept while you switch and Save writes them all back.' },
      { kind: 'added', text: 'Click-and-drag a note in the runway to move it to a new tick / lane. Drop position snaps to the chosen beat fraction (1/4, 1/8, 1/16, or 1/32 — selectable in the sidebar).' },
      { kind: 'added', text: 'Beat grid lines drawn on the runway, with fainter sub-beat lines at the current snap divisor.' },
      { kind: 'added', text: 'Lane labels show drum-kit names (Kick / Snare / Hi-hat / Tom / Cymbal) when editing a drum stem beatmap, with the underlying CH colour name shown next to it.' },
      { kind: 'changed', text: 'Arrow-key tick nudge now steps by the chosen snap divisor, not a fixed 1/32.' },
    ],
  },
  {
    version: '1.0',
    date: '2026-04-27',
    summary:
      'First named release. The app was renamed to Jamsesh Studio, the Create and Studio Library flows were merged onto a single page, and full per-track beatmap history was added.',
    entries: [
      { kind: 'added', text: 'Studio Library is now the home page — the dropzone, settings, and result screens render at the top, with the saved-track list directly below.' },
      { kind: 'added', text: 'Welcome card on the upload screen describing what Studio Library and Game Library each do.' },
      { kind: 'added', text: 'Album art thumbnails on every Studio Library row.' },
      { kind: 'added', text: 'Studio Library detail title now reads "Artist — Name" from the live song.ini fields and previews edits before save.' },
      { kind: 'added', text: 'Delete buttons on both the list rows and the detail view, with a confirmation modal before anything is removed.' },
      { kind: 'added', text: 'Stem cards include an inline player with play/pause, a scrub bar, and current/total time. Starting one stem auto-pauses any other.' },
      { kind: 'added', text: 'Stems-only mode — drop stems without a master mix and the backend muxes them with ffmpeg to synthesise song.ogg.' },
      { kind: 'added', text: 'Per-track beatmap history. Generated beatmaps are persisted under the track and listed as date chips on each stem card.' },
      { kind: 'added', text: 'Beatmap stats modal with parsed song.ini metadata, difficulty ratings, and a per-difficulty notes table (singles / holds / slides per lane, every chord pair, opens). ZIP / notes.chart / song.ogg / song.ini download links and delete-with-confirm in the footer.' },
      { kind: 'added', text: 'Beatmap stats modal also reachable from the post-separation result screen via "View stats".' },
      { kind: 'added', text: 'Kill task button on stem separation and beatmap generation. Best-effort cancel — the wrapper task and SSE stream stop immediately, the worker thread finishes naturally and the result is discarded.' },
      { kind: 'added', text: 'Versioning — visible v1.0 pill in the header and tagged release in git.' },
      { kind: 'changed', text: 'Renamed Tracks → Studio Library and Game Songs → Game Library in the nav and page headings.' },
      { kind: 'changed', text: 'Removed the standalone Create page; its flow now lives at the top of Studio Library.' },
      { kind: 'changed', text: 'Stem labels: rhythm.ogg now displays as "Bass", song.ogg displays as "Master Mix".' },
      { kind: 'changed', text: 'Generate Beatmap button is hidden on the Master Mix card — only individual instrument stems chart.' },
      { kind: 'changed', text: 'Studio Library list now reads name/artist/album/genre/year from each track\'s song.ini when present, so older tracks display the clean title even if their track.json still has the raw filename.' },
      { kind: 'changed', text: 'Selected track id is now a URL search param (?id=…). Browser back, forward, and Studio Library nav clicks all behave correctly.' },
      { kind: 'changed', text: 'Clicking the Studio Library nav from anywhere — including the result screen at the same / URL — now always returns you to the bare list view.' },
      { kind: 'changed', text: 'Publish-to-game status text now reads "Packaging stems and pushing to GitHub..." (was "Converting stems...", which was misleading because OGG stems are copied not re-encoded).' },
      { kind: 'fixed', text: 'Publish to GitHub no longer asks ffmpeg to convert song.ini or album.png as if they were stem audio. album.png is now copied straight into the published folder.' },
      { kind: 'fixed', text: 'Stems-only upload now shows an "Uploading N stems..." spinner. Previously the page went visually blank between submit and the SSE job starting.' },
    ],
  },
]

const KIND_STYLES: Record<Entry['kind'], string> = {
  added: 'bg-emerald-900/30 text-emerald-300 border-emerald-800/60',
  changed: 'bg-jam-600/15 text-jam-300 border-jam-600/40',
  fixed: 'bg-amber-900/30 text-amber-300 border-amber-800/60',
}

export default function ChangelogPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Changelog</h1>
        <p className="text-gray-500 mt-1">
          What's new in Jamsesh Studio. You're on v{STUDIO_VERSION}.
        </p>
      </div>

      <VersionsTable />

      {RELEASES.map((r) => (
        <section key={r.version} className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
          <header className="flex flex-wrap items-baseline gap-3 border-b border-gray-800 pb-3">
            <h2 className="text-lg font-semibold text-gray-100">v{r.version}</h2>
            <span className="text-xs text-gray-500 font-mono">{r.date}</span>
          </header>

          {r.summary && (
            <p className="text-sm text-gray-400">{r.summary}</p>
          )}

          <ul className="space-y-2">
            {r.entries.map((e, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span
                  className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wider ${KIND_STYLES[e.kind]}`}
                >
                  {e.kind}
                </span>
                <span className="text-gray-300 leading-snug">{e.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
