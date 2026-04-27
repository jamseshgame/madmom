import { useEffect, useRef, useState } from 'react'

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function StemPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [seeking, setSeeking] = useState(false)

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

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) audio.play()
    else audio.pause()
  }

  const handleSeek = (value: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = value
    setCurrentTime(value)
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
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={currentTime}
          onChange={(e) => handleSeek(Number(e.target.value))}
          onMouseDown={() => setSeeking(true)}
          onMouseUp={() => setSeeking(false)}
          onTouchStart={() => setSeeking(true)}
          onTouchEnd={() => setSeeking(false)}
          className="flex-1 h-1 accent-jam-500 cursor-pointer"
          aria-label="Seek"
          disabled={!duration}
        />
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
        onTimeUpdate={(e) => {
          if (!seeking) setCurrentTime(e.currentTarget.currentTime)
        }}
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
