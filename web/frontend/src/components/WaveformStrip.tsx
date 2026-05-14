import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react'

export interface ClipRegion {
  id: string
  startSec: number
  endSec: number
  name: string
  selected?: boolean
}

interface Props {
  peaks: Float32Array | null
  duration: number
  bucketSec: number
  currentTime: number
  onSeek: (sec: number) => void
  view: { start: number; end: number }
  onViewChange: (v: { start: number; end: number }) => void
  clips: ClipRegion[]
  onSelectClip?: (id: string | null) => void
  onCommitDragRegion?: (startSec: number, endSec: number) => void
  emptyStateText?: string
}

// Mini horizontal-strip waveform display, designed to live directly
// below the existing TutorialTimeline. Shares its `view` (zoom + pan)
// with the parent so x-pixel ↔ time stays aligned across both strips.
//
// Mouse:
//   plain drag        → define a new clip region
//   shift+click/drag  → scrub the playhead
//   wheel             → zoom centered on the cursor
export function WaveformStrip({
  peaks, duration, bucketSec, currentTime, onSeek, view, onViewChange,
  clips, onSelectClip, onCommitDragRegion, emptyStateText,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [drag, setDrag] = useState<{ startSec: number; curSec: number } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (!peaks || duration <= 0) {
    return (
      <div className="px-4 py-1.5 text-[11px] text-gray-600 italic bg-gray-950 border-y border-gray-800">
        {emptyStateText ?? 'No audio loaded — waveform unavailable.'}
      </div>
    )
  }

  const span = Math.max(0.001, view.end - view.start)
  const secToX = (s: number) => ((s - view.start) / span) * width
  const xToSec = (x: number) => view.start + (x / Math.max(1, width)) * span

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current!.getBoundingClientRect()
    const cursorSec = xToSec(e.clientX - rect.left)
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2
    const newSpan = Math.min(duration, Math.max(0.5, span * factor))
    let newStart = cursorSec - (cursorSec - view.start) * (newSpan / span)
    let newEnd = newStart + newSpan
    if (newStart < 0) { newEnd -= newStart; newStart = 0 }
    if (newEnd > duration) { newStart -= newEnd - duration; newEnd = duration }
    onViewChange({ start: Math.max(0, newStart), end: Math.min(duration, newEnd) })
  }

  const handleMouseDown = (e: MouseEvent) => {
    const rect = containerRef.current!.getBoundingClientRect()
    const sec = xToSec(e.clientX - rect.left)
    if (e.shiftKey) { onSeek(sec); return }
    for (const c of clips) {
      if (sec >= c.startSec && sec <= c.endSec) {
        onSelectClip?.(c.id)
        return
      }
    }
    onSelectClip?.(null)
    if (onCommitDragRegion) {
      setDrag({ startSec: sec, curSec: sec })
      // Capture the pointer so mouseup fires here even if the cursor leaves the strip.
      try { containerRef.current!.setPointerCapture((e as unknown as PointerEvent).pointerId) } catch {}
    }
  }
  const handleMouseMove = (e: MouseEvent) => {
    if (!drag) return
    const rect = containerRef.current!.getBoundingClientRect()
    setDrag({ ...drag, curSec: xToSec(e.clientX - rect.left) })
  }
  const handleMouseUp = () => {
    if (!drag) return
    const a = Math.max(0, Math.min(drag.startSec, drag.curSec))
    const b = Math.min(duration, Math.max(drag.startSec, drag.curSec))
    if (b - a > 0.05) onCommitDragRegion?.(a, b)
    else onSeek(drag.startSec)
    setDrag(null)
  }

  const cols: Array<{ x: number; h: number }> = []
  if (bucketSec > 0) {
    for (let x = 0; x < width; x += 2) {
      const sec = xToSec(x)
      const idx = Math.floor(sec / bucketSec)
      if (idx >= 0 && idx < peaks.length) {
        cols.push({ x, h: Math.max(1, peaks[idx] * 24) })
      }
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative h-12 bg-gray-950 border-y border-gray-800 select-none cursor-crosshair"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
    >
      <svg width={width} height={48} className="absolute inset-0 pointer-events-none">
        {cols.map(({ x, h }) => (
          <line key={x} x1={x} y1={24 - h / 2} x2={x} y2={24 + h / 2} stroke="#22d3ee" strokeWidth={1} />
        ))}
      </svg>
      {clips.map((c) => (
        <div
          key={c.id}
          className={`absolute top-0 bottom-0 border-x pointer-events-none ${
            c.selected ? 'bg-cyan-500/30 border-cyan-300' : 'bg-cyan-500/12 border-cyan-700/60'
          }`}
          style={{
            left: `${secToX(c.startSec)}px`,
            width: `${Math.max(1, secToX(c.endSec) - secToX(c.startSec))}px`,
          }}
        />
      ))}
      {drag && (
        <div
          className="absolute top-0 bottom-0 bg-fuchsia-400/30 border-x border-fuchsia-300 pointer-events-none"
          style={{
            left: `${secToX(Math.min(drag.startSec, drag.curSec))}px`,
            width: `${Math.abs(secToX(drag.curSec) - secToX(drag.startSec))}px`,
          }}
        />
      )}
      <div
        className="absolute top-0 bottom-0 w-px bg-yellow-400 pointer-events-none"
        style={{ left: `${secToX(currentTime)}px` }}
      />
    </div>
  )
}
