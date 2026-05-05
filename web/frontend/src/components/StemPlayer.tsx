import { useEffect, useRef, useState } from 'react'

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Single shared AudioContext — browsers limit how many you can spin up.
let _audioCtx: AudioContext | null = null
function getAudioContext(): AudioContext {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
  }
  return _audioCtx
}

const PEAK_BUCKETS = 240

// Decode and reduce to per-bucket max-abs amplitude. Peaks are kept in raw
// [0, 1] space — no per-stem normalization, so a near-silent stem looks
// near-silent next to a loud one.
async function fetchPeaks(src: string, signal: AbortSignal): Promise<Float32Array> {
  const res = await fetch(src, { signal })
  if (!res.ok) throw new Error(`${res.status}`)
  const buf = await res.arrayBuffer()
  const audioBuf = await getAudioContext().decodeAudioData(buf)
  const channels = audioBuf.numberOfChannels
  const bucketSize = Math.max(1, Math.floor(audioBuf.length / PEAK_BUCKETS))
  const peaks = new Float32Array(PEAK_BUCKETS)
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuf.getChannelData(ch)
    for (let i = 0; i < PEAK_BUCKETS; i++) {
      const start = i * bucketSize
      const end = Math.min(start + bucketSize, data.length)
      let max = 0
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j])
        if (v > max) max = v
      }
      if (max > peaks[i]) peaks[i] = max
    }
  }
  return peaks
}

export default function StemPlayer({
  src,
  peaks: peaksProp,
}: {
  src: string
  peaks?: number[] | null
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [peaks, setPeaks] = useState<Float32Array | null>(
    peaksProp ? Float32Array.from(peaksProp) : null,
  )
  const [peaksError, setPeaksError] = useState(false)

  // Pause this player whenever a different <audio> starts playing on the page,
  // so two stems don't blast over each other.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onPlayElsewhere = (e: Event) => {
      if (e.target !== audio && e.target instanceof HTMLAudioElement) {
        audio.pause()
      }
    }
    document.addEventListener('play', onPlayElsewhere, true)
    return () => document.removeEventListener('play', onPlayElsewhere, true)
  }, [])

  // Prefer backend-precomputed peaks when available; otherwise decode in-browser.
  useEffect(() => {
    if (peaksProp) {
      setPeaks(Float32Array.from(peaksProp))
      setPeaksError(false)
      return
    }
    const ctrl = new AbortController()
    setPeaks(null)
    setPeaksError(false)
    fetchPeaks(src, ctrl.signal)
      .then(setPeaks)
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setPeaksError(true)
      })
    return () => ctrl.abort()
  }, [src, peaksProp])

  // Draw waveform + playhead.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== w * dpr) canvas.width = w * dpr
    if (canvas.height !== h * dpr) canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const mid = h / 2
    if (!peaks) {
      // Subtle placeholder while decoding.
      ctx.fillStyle = 'rgba(107, 114, 128, 0.25)' // gray-500/25
      ctx.fillRect(0, mid - 0.5, w, 1)
      return
    }
    const playRatio = duration > 0 ? currentTime / duration : 0
    const playX = Math.floor(playRatio * w)

    // One vertical bar per pixel (or per bucket if we've got more pixels than buckets).
    const bars = Math.min(w, peaks.length)
    const barW = w / bars
    for (let i = 0; i < bars; i++) {
      const t = i / bars
      const peakIdx = Math.floor(t * peaks.length)
      const amp = peaks[peakIdx]
      const barH = Math.max(1, amp * (h - 2))
      const x = i * barW
      const xPx = Math.floor(x)
      ctx.fillStyle = xPx < playX ? 'rgba(217, 70, 239, 0.9)' : 'rgba(156, 163, 175, 0.55)' // jam vs gray-400
      ctx.fillRect(xPx, mid - barH / 2, Math.max(1, Math.floor(barW)), barH)
    }
  }, [peaks, currentTime, duration])

  // Click / drag the canvas to seek.
  const seekFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const audio = audioRef.current
    if (!canvas || !audio || !duration) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const t = (x / rect.width) * duration
    audio.currentTime = t
    setCurrentTime(t)
  }

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) audio.play()
    else audio.pause()
  }

  return (
    <div className="w-full flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Play'}
          className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] leading-none transition-colors ${
            playing
              ? 'bg-jam-600 hover:bg-jam-500 text-white'
              : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
          }`}
        >
          {playing ? <span className="tracking-tighter">❚❚</span> : <span className="ml-0.5">▶</span>}
        </button>
        <div className="relative flex-1 h-7">
          <canvas
            ref={canvasRef}
            className={`w-full h-full ${duration ? 'cursor-pointer' : 'cursor-default'} ${peaksError ? 'opacity-40' : ''}`}
            onPointerDown={(e) => {
              if (!duration) return
              e.currentTarget.setPointerCapture(e.pointerId)
              seekFromEvent(e)
            }}
            onPointerMove={(e) => {
              if (e.buttons & 1) seekFromEvent(e)
            }}
            aria-label="Waveform — click or drag to seek"
            role="slider"
            aria-valuemin={0}
            aria-valuemax={duration || 0}
            aria-valuenow={currentTime}
          />
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-gray-500 font-mono px-0.5">
        <span>{fmt(currentTime)}</span>
        <span>{fmt(duration)}</span>
      </div>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setCurrentTime(0)
        }}
      />
    </div>
  )
}
