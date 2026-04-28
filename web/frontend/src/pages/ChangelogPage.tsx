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
