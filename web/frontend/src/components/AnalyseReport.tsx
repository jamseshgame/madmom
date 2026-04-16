interface DifficultyStats {
  total_events: number
  singles: Record<string, number>
  holds: Record<string, number>
  chords: Record<string, number>
  chord_holds: Record<string, number>
  slides: Record<string, number>
  chord_slides: Record<string, number>
  open_normal: number
  open_hold: number
  open_slide: number
}

interface AnalyseData {
  song_name: string
  resolution: number
  bpm: number
  difficulties: Record<string, DifficultyStats>
}

const FRETS = ['0', '1', '2', '3', '4']
const PAIRS = ['0+1', '1+2', '2+3', '3+4']
const DIFF_ORDER = ['ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle']

function fmt(n: number, total: number): string {
  const pct = total > 0 ? ((n / total) * 100).toFixed(1) : '0.0'
  return `${n} (${pct}%)`
}

function DiffTable({ label, stats }: { label: string; stats: DifficultyStats }) {
  const t = stats.total_events
  if (t === 0) return <p className="text-gray-500 text-sm">{label}: no events</p>

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h4 className="font-semibold text-jam-300 mb-3">
        {label} <span className="text-gray-500 font-normal">({t} events)</span>
      </h4>

      <table className="w-full text-sm text-left">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="py-1 pr-4">Fret</th>
            <th className="py-1 pr-4">Tap</th>
            <th className="py-1 pr-4">Hold</th>
            <th className="py-1">Slide</th>
          </tr>
        </thead>
        <tbody>
          {FRETS.map((f) => (
            <tr key={f} className="border-b border-gray-800/50">
              <td className="py-1 pr-4 font-mono">{f}</td>
              <td className="py-1 pr-4">{fmt(stats.singles[f] || 0, t)}</td>
              <td className="py-1 pr-4">{fmt(stats.holds[f] || 0, t)}</td>
              <td className="py-1">{fmt(stats.slides[f] || 0, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="w-full text-sm text-left mt-3">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="py-1 pr-4">Chord</th>
            <th className="py-1 pr-4">Tap</th>
            <th className="py-1 pr-4">Hold</th>
            <th className="py-1">Slide</th>
          </tr>
        </thead>
        <tbody>
          {PAIRS.map((p) => (
            <tr key={p} className="border-b border-gray-800/50">
              <td className="py-1 pr-4 font-mono">{p}</td>
              <td className="py-1 pr-4">{fmt(stats.chords[p] || 0, t)}</td>
              <td className="py-1 pr-4">{fmt(stats.chord_holds[p] || 0, t)}</td>
              <td className="py-1">{fmt(stats.chord_slides[p] || 0, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {(stats.open_normal > 0 || stats.open_hold > 0 || stats.open_slide > 0) && (
        <div className="mt-3 text-sm text-gray-400">
          Open: {fmt(stats.open_normal, t)} tap, {fmt(stats.open_hold, t)} hold, {fmt(stats.open_slide, t)} slide
        </div>
      )}
    </div>
  )
}

export default function AnalyseReport({ data }: { data: AnalyseData }) {
  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h3 className="text-lg font-semibold text-jam-300 mb-2">Chart Info</h3>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
          <dt className="text-gray-500">Song</dt>
          <dd>{data.song_name}</dd>
          <dt className="text-gray-500">BPM</dt>
          <dd>{data.bpm.toFixed(2)}</dd>
          <dt className="text-gray-500">Resolution</dt>
          <dd>{data.resolution}</dd>
          <dt className="text-gray-500">Difficulties</dt>
          <dd>{Object.keys(data.difficulties).length}</dd>
        </dl>
      </div>

      {DIFF_ORDER.filter((d) => d in data.difficulties).map((d) => (
        <DiffTable key={d} label={d.replace('Single', '')} stats={data.difficulties[d]} />
      ))}
    </div>
  )
}
