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
