# Scene Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire scene-control cues — global flags (`[Scene]` section) and timeline events (`[Events]` payloads like `onboard_L_primary`) — into the manual beatmap editor, and ship a handover doc for the Unity engineer.

**Architecture:** Chart-format parsing/serialization for the new section + the new event payloads is extracted into a focused module (`sceneEvents.ts`) so the existing `BeatmapEditor.tsx` (already ~2k lines) doesn't grow unwieldy. The editor imports from that module and adds (1) a "Scene" sidebar card with four numeric inputs bound to the global flags, (2) a second timeline row underneath the existing tutorial row driven by the same parsed event list, (3) a categorized "+ Scene event" picker. Round-trip is conservative: unknown `[Scene]` keys and unknown `[Events]` payloads pass through untouched.

**Tech stack:** TypeScript / React 18 / Vite. No test framework on the frontend yet — verification is `npm run build` (type-check + bundle) plus manual smoke-test in the dev server. The handover doc is plain Markdown.

---

## File map

- **Create** `web/frontend/src/components/sceneEvents.ts`
  - Types: `SceneFlags`, `SceneEvent`, `SceneEventCatalogEntry`
  - Catalog: `SCENE_EVENT_CATALOG` (grouped list of all known events, with which accept duration)
  - Pure functions: `parseSceneFlags`, `serializeSceneFlags`, `parseSceneEvents`, `serializeSceneEvents`, `applySceneToFullText`
- **Modify** `web/frontend/src/components/BeatmapEditor.tsx`
  - Extend `ChartState` with `sceneFlags`, `sceneFlagsUnknown`, `sceneEvents`
  - `parseChart` calls scene parsers; `applyTutorialToFullText` is wrapped (or paralleled) by `applySceneToFullText` on save
  - Add `SceneTimeline` row in the header area (below `TutorialTimeline`)
  - Add `+ Scene event` picker button + dropdown (categorized)
  - Add right-sidebar **Scene** card with four numeric inputs
  - Hook keyboard delete + drag-to-resize for duration on scene events
- **Create** `web/docs/SCENE_EVENTS.md`
  - Handover doc for the Unity engineer (format spec, full event catalog, Unity architecture suggestion)

No backend changes. No test infrastructure changes.

---

## Task 1: Scaffold `sceneEvents.ts` with types and the catalog

**Files:**
- Create: `web/frontend/src/components/sceneEvents.ts`

- [ ] **Step 1: Create the module with shared types and the event catalog**

```ts
// web/frontend/src/components/sceneEvents.ts
//
// Pure parsing/serialization helpers + event catalog for scene-control cues
// in the .chart format. Extracted from BeatmapEditor.tsx to keep the editor
// component focused on UI.

export interface SceneFlags {
  floorcrowd: number     // 0 = off; 0.1 = on; 0.2+ = more intense
  lasers_center: number  // same scheme
  lasers_left: number
  lasers_right: number
}

export const DEFAULT_SCENE_FLAGS: SceneFlags = {
  floorcrowd: 0,
  lasers_center: 0,
  lasers_left: 0,
  lasers_right: 0,
}

export interface SceneEvent {
  id: string         // ephemeral; regenerated per parse
  tick: number
  name: string       // e.g. "onboard_L_primary"
  duration: number   // ticks; 0 = instantaneous
}

export type SceneEventGroup =
  | 'controllers_l'
  | 'controllers_r'
  | 'hand'
  | 'highway'
  | 'beatline'
  | 'misc'

export interface SceneEventCatalogEntry {
  name: string
  group: SceneEventGroup
  groupLabel: string
  itemLabel: string       // human-readable label for the picker
  acceptsDuration: boolean
}

// All known scene-event names. Editor uses this to populate the picker and
// to decide whether to show the right-edge resize handle.
export const SCENE_EVENT_CATALOG: SceneEventCatalogEntry[] = [
  // Controllers L
  { name: 'onboard_L',             group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Show controller',     acceptsDuration: true },
  { name: 'onboard_L_rotate',      group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Rotate',               acceptsDuration: true },
  { name: 'onboard_L_primary',     group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Primary glow',         acceptsDuration: true },
  { name: 'onboard_L_secondary',   group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Secondary glow',       acceptsDuration: true },
  { name: 'onboard_L_menu',        group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Menu glow',            acceptsDuration: true },
  { name: 'onboard_L_trigger',     group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Trigger glow',         acceptsDuration: true },
  { name: 'onboard_L_grip',        group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Grip glow',            acceptsDuration: true },
  { name: 'onboard_L_thumbstick',  group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Thumbstick glow',      acceptsDuration: true },
  { name: 'onboard_L_stickclick',  group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Stick-click glow',     acceptsDuration: true },
  // Controllers R
  { name: 'onboard_R',             group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Show controller',     acceptsDuration: true },
  { name: 'onboard_R_rotate',      group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Rotate',               acceptsDuration: true },
  { name: 'onboard_R_primary',     group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Primary glow',         acceptsDuration: true },
  { name: 'onboard_R_secondary',   group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Secondary glow',       acceptsDuration: true },
  { name: 'onboard_R_menu',        group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Menu glow',            acceptsDuration: true },
  { name: 'onboard_R_trigger',     group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Trigger glow',         acceptsDuration: true },
  { name: 'onboard_R_grip',        group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Grip glow',            acceptsDuration: true },
  { name: 'onboard_R_thumbstick',  group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Thumbstick glow',      acceptsDuration: true },
  { name: 'onboard_R_stickclick',  group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Stick-click glow',     acceptsDuration: true },
  // Hand indicator
  { name: 'onboard_handindicator_show',  group: 'hand', groupLabel: 'Hand indicator', itemLabel: 'Show',  acceptsDuration: true  },
  { name: 'onboard_handindicator_hide',  group: 'hand', groupLabel: 'Hand indicator', itemLabel: 'Hide',  acceptsDuration: false },
  { name: 'onboard_handindicator_flash', group: 'hand', groupLabel: 'Hand indicator', itemLabel: 'Flash', acceptsDuration: false },
  // Highway
  { name: 'onboard_highway_show', group: 'highway', groupLabel: 'Highway', itemLabel: 'Show', acceptsDuration: true  },
  { name: 'onboard_highway_hide', group: 'highway', groupLabel: 'Highway', itemLabel: 'Hide', acceptsDuration: false },
  // Beatline
  { name: 'onboard_beatline_show',         group: 'beatline', groupLabel: 'Beatline', itemLabel: 'Show',          acceptsDuration: true  },
  { name: 'onboard_beatline_hide',         group: 'beatline', groupLabel: 'Beatline', itemLabel: 'Hide',          acceptsDuration: false },
  { name: 'onboard_beatline_flash',        group: 'beatline', groupLabel: 'Beatline', itemLabel: 'Flash',         acceptsDuration: false },
  { name: 'onboard_beatline_showsequence', group: 'beatline', groupLabel: 'Beatline', itemLabel: 'Show sequence', acceptsDuration: true  },
  { name: 'onboard_beatline_hidesequence', group: 'beatline', groupLabel: 'Beatline', itemLabel: 'Hide sequence', acceptsDuration: false },
  // Misc
  { name: 'onboard_controllerfretslide', group: 'misc', groupLabel: 'Misc', itemLabel: 'Controller fret slide', acceptsDuration: true },
]

const KNOWN_SCENE_EVENT_NAMES = new Set(SCENE_EVENT_CATALOG.map((e) => e.name))

export function isKnownSceneEventName(name: string): boolean {
  return KNOWN_SCENE_EVENT_NAMES.has(name)
}

export function findCatalogEntry(name: string): SceneEventCatalogEntry | undefined {
  return SCENE_EVENT_CATALOG.find((e) => e.name === name)
}
```

- [ ] **Step 2: Verify the file type-checks**

Run from `web/frontend/`:

```
npm run build
```

Expected: build succeeds. The new module isn't imported yet, but `tsc` will still type-check it.

- [ ] **Step 3: Commit**

```
git add web/frontend/src/components/sceneEvents.ts
git commit -m "feat(editor): scaffold scene-event types and catalog"
```

---

## Task 2: Add scene-flags parser and serializer

**Files:**
- Modify: `web/frontend/src/components/sceneEvents.ts`

- [ ] **Step 1: Append parsers/serializers for `[Scene]`**

Append to the bottom of `sceneEvents.ts`:

```ts
// ── [Scene] section parsing ────────────────────────────────────────────────
//
// Format: simple `key = value` lines inside `[Scene] { ... }`. Unknown keys
// are kept in a passthrough map so future flags survive a round-trip through
// an older editor.

const SCENE_FLAG_KEYS: (keyof SceneFlags)[] = [
  'floorcrowd', 'lasers_center', 'lasers_left', 'lasers_right',
]

const SCENE_KEY_SET = new Set<string>(SCENE_FLAG_KEYS)

export interface ParsedScene {
  flags: SceneFlags
  unknownKeys: Record<string, string>  // verbatim values for keys we don't model
}

export function parseSceneFlags(text: string): ParsedScene {
  const m = text.match(/\[Scene\]\s*\{([^}]*)\}/)
  const flags: SceneFlags = { ...DEFAULT_SCENE_FLAGS }
  const unknownKeys: Record<string, string> = {}
  if (!m) return { flags, unknownKeys }
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/^\s*;.*$/, '').trim()
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (SCENE_KEY_SET.has(key)) {
      const num = Number(val)
      if (Number.isFinite(num)) {
        flags[key as keyof SceneFlags] = num
      }
    } else {
      unknownKeys[key] = val
    }
  }
  return { flags, unknownKeys }
}

export function serializeSceneFlags(
  flags: SceneFlags,
  unknownKeys: Record<string, string>,
): string {
  const lines: string[] = []
  for (const key of SCENE_FLAG_KEYS) {
    const v = flags[key]
    if (!Number.isFinite(v)) continue
    if (v === 0) continue          // omit defaults to keep diffs small
    lines.push(`  ${key} = ${formatSceneNumber(v)}`)
  }
  for (const [key, val] of Object.entries(unknownKeys)) {
    lines.push(`  ${key} = ${val}`)
  }
  if (lines.length === 0) return ''
  return `[Scene]\n{\n${lines.join('\n')}\n}\n`
}

function formatSceneNumber(n: number): string {
  // Trim trailing zeros and the decimal point if integer; otherwise keep up to
  // 4 fractional digits to allow fine-grained intensity steps.
  if (Number.isInteger(n)) return String(n)
  return Number(n.toFixed(4)).toString()
}
```

- [ ] **Step 2: Verify build**

```
npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```
git add web/frontend/src/components/sceneEvents.ts
git commit -m "feat(editor): parse and serialize [Scene] flags"
```

---

## Task 3: Add scene-events parser and serializer

**Files:**
- Modify: `web/frontend/src/components/sceneEvents.ts`

- [ ] **Step 1: Append parsers/serializers for `onboard_*` payloads in `[Events]`**

Append to the bottom of `sceneEvents.ts`:

```ts
// ── [Events] payload parsing ───────────────────────────────────────────────
//
// Standard chart `[Events]` lines look like `<tick> = E "<payload>"`. The
// payload is whatever the engine wants. We claim payloads that begin with
// `onboard_` (a single token) optionally followed by a numeric duration:
//
//   36864 = E "onboard_L_primary 232"
//   192000 = E "onboard_highway_show"
//
// All other E-lines (section/lyric markers, etc.) are NOT touched: we keep
// them verbatim in the passthrough text returned by parseSceneEvents.

const SCENE_EVENT_LINE = /^\s*(\d+)\s*=\s*E\s+"([^"]*)"\s*$/
// Matches: name=group1, optional space + duration=group2
const SCENE_PAYLOAD = /^([A-Za-z][A-Za-z0-9_]*)(?:\s+(\d+))?$/

export interface ParsedSceneEvents {
  events: SceneEvent[]
  // Lines from [Events] that we did NOT claim. Re-emitted verbatim on save.
  passthroughLines: string[]
  // True if the chart originally had an [Events] section at all. Determines
  // whether we re-emit the section even when both events and passthroughLines
  // are empty (we don't, in that case).
  hadSection: boolean
}

export function parseSceneEvents(text: string): ParsedSceneEvents {
  const m = text.match(/\[Events\]\s*\{([^}]*)\}/)
  if (!m) {
    return { events: [], passthroughLines: [], hadSection: false }
  }
  const events: SceneEvent[] = []
  const passthroughLines: string[] = []
  let counter = 0
  for (const raw of m[1].split(/\r?\n/)) {
    const stripped = raw.replace(/^\s*;.*$/, '')
    if (!stripped.trim()) continue
    const lm = stripped.match(SCENE_EVENT_LINE)
    if (!lm) {
      passthroughLines.push(stripped.trimEnd())
      continue
    }
    const tick = Number(lm[1])
    const payload = lm[2].trim()
    const pm = payload.match(SCENE_PAYLOAD)
    if (!pm || !pm[1].startsWith('onboard_')) {
      passthroughLines.push(stripped.trimEnd())
      continue
    }
    events.push({
      id: `scene-${tick}-${counter++}`,
      tick,
      name: pm[1],
      duration: pm[2] ? Number(pm[2]) : 0,
    })
  }
  return { events, passthroughLines, hadSection: true }
}

export function serializeSceneEvents(
  events: SceneEvent[],
  passthroughLines: string[],
): string {
  if (events.length === 0 && passthroughLines.length === 0) return ''
  const sceneLines = [...events]
    .sort((a, b) => a.tick - b.tick)
    .map((e) => {
      const dur = e.duration > 0 ? ` ${e.duration}` : ''
      return `  ${e.tick} = E "${e.name}${dur}"`
    })
  // Merge passthrough + scene lines, then sort by leading tick to keep
  // section/lyric markers in the right place. Lines without a leading tick
  // sort to position 0.
  const all = [...passthroughLines, ...sceneLines].sort((a, b) => {
    const ta = Number(a.match(/^\s*(\d+)/)?.[1] ?? 0)
    const tb = Number(b.match(/^\s*(\d+)/)?.[1] ?? 0)
    return ta - tb
  })
  return `[Events]\n{\n${all.join('\n')}\n}\n`
}
```

- [ ] **Step 2: Verify build**

```
npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```
git add web/frontend/src/components/sceneEvents.ts
git commit -m "feat(editor): parse and serialize onboard_* events in [Events]"
```

---

## Task 4: Add `applySceneToFullText` round-trip helper

**Files:**
- Modify: `web/frontend/src/components/sceneEvents.ts`

- [ ] **Step 1: Append the round-trip helper**

Append to the bottom of `sceneEvents.ts`:

```ts
// ── Round-trip helper ──────────────────────────────────────────────────────
//
// Strips the existing [Scene] and [Events] sections from `fullText` and
// re-emits them from in-memory state. Mirrors applyTutorialToFullText in
// BeatmapEditor.tsx.

export function applySceneToFullText(
  fullText: string,
  flags: SceneFlags,
  unknownFlagKeys: Record<string, string>,
  events: SceneEvent[],
  passthroughLines: string[],
): string {
  let stripped = fullText.replace(/\[Scene\]\s*\{[^}]*\}\s*/g, '')
  stripped = stripped.replace(/\[Events\]\s*\{[^}]*\}\s*/g, '')
  const sceneBlock = serializeSceneFlags(flags, unknownFlagKeys)
  const eventsBlock = serializeSceneEvents(events, passthroughLines)
  if (!sceneBlock && !eventsBlock) return stripped
  return stripped.trimEnd() + '\n' + sceneBlock + eventsBlock
}
```

- [ ] **Step 2: Verify build**

```
npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```
git add web/frontend/src/components/sceneEvents.ts
git commit -m "feat(editor): add applySceneToFullText round-trip helper"
```

---

## Task 5: Wire scene state into `ChartState` and parsing

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Import the new module**

Edit the import block at the top of `BeatmapEditor.tsx` (above existing imports):

```ts
import {
  DEFAULT_SCENE_FLAGS, SceneEvent, SceneFlags,
  applySceneToFullText, parseSceneEvents, parseSceneFlags,
} from './sceneEvents'
```

- [ ] **Step 2: Extend `ChartState`**

Find the `interface ChartState { ... }` declaration (around line 55) and add the four new fields immediately before the closing brace:

```ts
  sceneFlags: SceneFlags
  sceneFlagsUnknown: Record<string, string>
  sceneEvents: SceneEvent[]
  sceneEventsPassthrough: string[]
```

- [ ] **Step 3: Populate scene state in `parseChart`**

In `parseChart` (around line 304), before the `return { ... }` block, parse and prepare the scene state:

```ts
  const scene = parseSceneFlags(text)
  const sceneEvents = parseSceneEvents(text)
```

Then extend the returned object with the new fields:

```ts
  return {
    fullText: text, resolution, bpm, bpmRaw, songName,
    availableSections, activeName, notes,
    tutorialEnabled, tutorial, musicSections,
    sceneFlags: scene.flags,
    sceneFlagsUnknown: scene.unknownKeys,
    sceneEvents: sceneEvents.events,
    sceneEventsPassthrough: sceneEvents.passthroughLines,
  }
```

- [ ] **Step 4: Apply scene on save**

Find every spot that calls `applyTutorialToFullText(...)` (there are two: in `switchDifficulty` ~line 1123 and in `handleSave` ~line 1143). Immediately after each call to `applyTutorialToFullText`, chain `applySceneToFullText`:

```ts
    newFull = applyTutorialToFullText(newFull, chart.tutorial, chart.tutorialEnabled, chart.musicSections)
    newFull = applySceneToFullText(
      newFull,
      chart.sceneFlags,
      chart.sceneFlagsUnknown,
      chart.sceneEvents,
      chart.sceneEventsPassthrough,
    )
```

- [ ] **Step 5: Build and verify**

```
npm run build
```

Expected: build succeeds. No UI yet — the round-trip is in place but invisible.

- [ ] **Step 6: Manual round-trip smoke test**

1. Start the dev server (`npm run dev` in `web/frontend/`, plus the backend if not running).
2. Open an existing beatmap in the editor.
3. Hit **Save** without making changes.
4. Check the saved chart on disk: existing `[Events]` lines (sections/lyrics) survive verbatim. No `[Scene]` section appears (defaults are zero, so it's omitted). No errors in console.

- [ ] **Step 7: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): parse and round-trip [Scene] and onboard_* events"
```

---

## Task 6: Add the Scene sidebar card

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Add a `setSceneFlag` helper**

Below the existing `updateTutorial` helper (around line 1170-1178), add:

```ts
  const setSceneFlag = (key: keyof SceneFlags, value: number) => {
    if (!chart) return
    setChart({
      ...chart,
      sceneFlags: { ...chart.sceneFlags, [key]: value },
    })
    setDirty(true)
  }
```

- [ ] **Step 2: Add the sidebar card**

In the `<aside>` block of the JSX (right sidebar, around line 1503), insert a new `<section>` immediately before the existing **Tutorial** section (before the line `{chart && (` near line 1624):

```tsx
          {chart && (
            <section className="border-t border-gray-800 pt-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Scene</h3>
              <p className="text-[11px] text-gray-600 mb-2 leading-snug">
                Song-wide flags applied at load. <span className="font-mono">0</span> = off,
                <span className="font-mono"> 0.1</span> = on, higher = more intense.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {([
                  ['floorcrowd', 'Floor crowd'],
                  ['lasers_center', 'Lasers · center'],
                  ['lasers_left', 'Lasers · left'],
                  ['lasers_right', 'Lasers · right'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="text-[10px] text-gray-500">{label}</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={chart.sceneFlags[key]}
                      onChange={(e) => setSceneFlag(key, Math.max(0, Number(e.target.value) || 0))}
                      className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 font-mono"
                    />
                  </label>
                ))}
              </div>
            </section>
          )}
```

- [ ] **Step 3: Build and visually verify**

```
npm run build
```

Then in the dev server: open a beatmap → the right sidebar shows a new "Scene" card with four numeric inputs. Set `floorcrowd = 0.1`, save, then re-open: the value persists, and the chart on disk now contains:

```
[Scene]
{
  floorcrowd = 0.1
}
```

- [ ] **Step 4: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): scene-flags sidebar card (floorcrowd, lasers)"
```

---

## Task 7: Add the SceneTimeline row component

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Define the new component above the `BeatmapEditor` function**

Add this new component immediately after the existing `TutorialTimeline` function (search for `function TutorialTimeline` and find its closing brace; insert after it). It mirrors the tutorial-timeline patterns (zoom, scrub, drag-to-move) but for scene events; resize-by-right-edge is the new interaction.

```tsx
// ── SceneTimeline ──────────────────────────────────────────────────────────
// Sibling row to TutorialTimeline. Renders scene events as a row of bands
// (durational events) and spikes (instantaneous events). Click event to
// select; drag body to move tick; drag right edge to resize duration.

interface SceneTimelineProps {
  duration: number
  bpm: number
  resolution: number
  events: SceneEvent[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMoveEvent: (id: string, tick: number) => void
  onResizeEvent: (id: string, duration: number) => void
}

function SceneTimeline({
  duration, bpm, resolution, events,
  selectedId, onSelect, onMoveEvent, onResizeEvent,
}: SceneTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const dragRef = useRef<
    | { kind: 'move'; id: string; offset: number }
    | { kind: 'resize'; id: string; startTick: number; pivotX: number }
    | null
  >(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const span = Math.max(0.001, duration)
  const tickToSec = (t: number) => (t / resolution) * (60 / bpm)
  const secToX = (s: number) => (s / span) * width
  const xToSec = (x: number) => (x / Math.max(1, width)) * span
  const secToTick = (s: number) => Math.max(0, Math.round((s * bpm * resolution) / 60))

  const handleMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const rect = containerRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (drag.kind === 'move') {
      const sec = Math.max(0, Math.min(duration, xToSec(x - drag.offset)))
      onMoveEvent(drag.id, secToTick(sec))
    } else {
      const ev = events.find((e) => e.id === drag.id)
      if (!ev) return
      const cursorTick = secToTick(Math.max(0, xToSec(x)))
      const next = Math.max(0, cursorTick - drag.startTick)
      onResizeEvent(drag.id, next)
    }
  }

  const handleMouseUp = () => { dragRef.current = null }

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      className="relative h-6 bg-gray-950 border border-gray-800 rounded overflow-hidden select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null)
      }}
    >
      {events.map((ev) => {
        const startSec = tickToSec(ev.tick)
        const endSec = tickToSec(ev.tick + ev.duration)
        const x = secToX(startSec)
        const w = Math.max(2, secToX(endSec) - x)
        const isSel = ev.id === selectedId
        return (
          <div
            key={ev.id}
            onMouseDown={(e) => {
              e.stopPropagation()
              const rect = containerRef.current!.getBoundingClientRect()
              const localX = e.clientX - rect.left
              dragRef.current = { kind: 'move', id: ev.id, offset: localX - x }
              onSelect(ev.id)
            }}
            title={`${ev.name} @ tick ${ev.tick}${ev.duration > 0 ? ` (dur ${ev.duration})` : ''}`}
            className={`absolute top-0 bottom-0 ${isSel ? 'bg-emerald-400/70' : 'bg-emerald-600/60'} hover:bg-emerald-500/80 cursor-grab`}
            style={{ left: x, width: w }}
          >
            <span className="text-[9px] text-emerald-50 px-1 truncate block leading-6">{ev.name}</span>
            {ev.duration > 0 && (
              <div
                onMouseDown={(e) => {
                  e.stopPropagation()
                  dragRef.current = { kind: 'resize', id: ev.id, startTick: ev.tick, pivotX: x }
                  onSelect(ev.id)
                }}
                className="absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize bg-emerald-200/40 hover:bg-emerald-200/80"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Build**

```
npm run build
```

Expected: build succeeds (the component is defined but not yet rendered).

- [ ] **Step 3: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): SceneTimeline component (move/resize events)"
```

---

## Task 8: Render the SceneTimeline in the header + add picker UI

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Update the import to bring in the catalog**

Replace the import added in Task 5 with:

```ts
import {
  DEFAULT_SCENE_FLAGS, SCENE_EVENT_CATALOG, SceneEvent, SceneEventGroup,
  SceneFlags, applySceneToFullText, parseSceneEvents, parseSceneFlags,
} from './sceneEvents'
```

- [ ] **Step 2: Add scene editing helpers**

Below `updateTutorialEvent` (~line 1297), add:

```ts
  const [sceneSelectedId, setSceneSelectedId] = useState<string | null>(null)
  const [scenePickerOpen, setScenePickerOpen] = useState(false)

  const updateScene = (next: SceneEvent[]) => {
    if (!chart) return
    setChart({ ...chart, sceneEvents: next })
    setDirty(true)
  }

  const moveSceneEvent = (id: string, tick: number) => {
    if (!chart) return
    updateScene(chart.sceneEvents.map((e) => (e.id === id ? { ...e, tick } : e)))
  }

  const resizeSceneEvent = (id: string, duration: number) => {
    if (!chart) return
    updateScene(chart.sceneEvents.map((e) => (e.id === id ? { ...e, duration } : e)))
  }

  const removeSceneEvent = (id: string) => {
    if (!chart) return
    updateScene(chart.sceneEvents.filter((e) => e.id !== id))
    if (sceneSelectedId === id) setSceneSelectedId(null)
  }

  const addSceneEvent = (name: string) => {
    if (!chart) return
    const entry = SCENE_EVENT_CATALOG.find((e) => e.name === name)
    const ev: SceneEvent = {
      id: `scene-${Date.now()}`,
      tick: playheadTick,
      name,
      duration: entry?.acceptsDuration ? 384 : 0,
    }
    updateScene([...chart.sceneEvents, ev])
    setSceneSelectedId(ev.id)
    setScenePickerOpen(false)
  }
```

- [ ] **Step 3: Add Backspace handler for scene events**

In the existing keydown effect (search for `if (e.key === 'Delete' || e.key === 'Backspace')` around line 1097, scoped to note deletion). Above that whole `useEffect`, add a new effect:

```ts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (sceneSelectedId === null) return
      if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        removeSceneEvent(sceneSelectedId)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sceneSelectedId, chart])
```

- [ ] **Step 4: Render the SceneTimeline + picker in the header**

In the header JSX (around line 1454, the `<div className="flex-1 min-w-0 h-12">` block that holds the `<TutorialTimeline />`), replace the surrounding wrapper to stack two rows:

```tsx
        {/* Stacked timelines: tutorial events on top, scene events below. */}
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="h-7">
            {chart && duration > 0 ? (
              <TutorialTimeline
                duration={duration}
                currentTime={currentTime}
                bpm={chart.bpm}
                resolution={chart.resolution}
                events={chart.tutorialEnabled ? chart.tutorial : []}
                snapDivisor={snapDivisor}
                onSeek={seekSeconds}
                onMoveEvent={(id, tick) => updateTutorialEvent(id, { tick } as Partial<TutorialEvent>)}
              />
            ) : (
              <div className="h-full bg-gray-950 border border-gray-800 rounded text-[11px] text-gray-700 flex items-center justify-center">
                {loadError ? '—' : 'loading audio…'}
              </div>
            )}
          </div>
          <div className="h-6 flex items-stretch gap-1">
            <div className="relative shrink-0">
              <button
                onClick={() => setScenePickerOpen((v) => !v)}
                className="h-full px-2 bg-emerald-700/50 hover:bg-emerald-600/60 border border-emerald-700/60 text-emerald-100 rounded text-[10px] font-medium transition-colors"
                title="Add a scene event at the playhead"
              >
                + Scene
              </button>
              {scenePickerOpen && (
                <ScenePicker
                  onPick={addSceneEvent}
                  onClose={() => setScenePickerOpen(false)}
                />
              )}
            </div>
            <div className="flex-1 min-w-0">
              {chart && duration > 0 ? (
                <SceneTimeline
                  duration={duration}
                  bpm={chart.bpm}
                  resolution={chart.resolution}
                  events={chart.sceneEvents}
                  selectedId={sceneSelectedId}
                  onSelect={setSceneSelectedId}
                  onMoveEvent={moveSceneEvent}
                  onResizeEvent={resizeSceneEvent}
                />
              ) : (
                <div className="h-full bg-gray-950 border border-gray-800 rounded" />
              )}
            </div>
          </div>
        </div>
```

(Replace the existing `<div className="flex-1 min-w-0 h-12">…</div>` block in its entirety with the above.)

- [ ] **Step 5: Add the `ScenePicker` component**

Place this new component immediately above `function BeatmapEditor()` (~line 669, alongside `TutorialTimeline` and `SceneTimeline`):

```tsx
function ScenePicker({
  onPick, onClose,
}: { onPick: (name: string) => void; onClose: () => void }) {
  // Group catalog by group label, preserving catalog order.
  const groups: { label: string; entries: typeof SCENE_EVENT_CATALOG }[] = []
  for (const entry of SCENE_EVENT_CATALOG) {
    const last = groups[groups.length - 1]
    if (last && last.label === entry.groupLabel) last.entries.push(entry)
    else groups.push({ label: entry.groupLabel, entries: [entry] })
  }
  return (
    <div
      className="absolute top-full left-0 mt-1 w-64 max-h-80 overflow-y-auto bg-gray-900 border border-gray-700 rounded-md shadow-2xl z-[80] p-1.5 space-y-1.5"
      onMouseLeave={onClose}
    >
      {groups.map((g) => (
        <div key={g.label}>
          <div className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            {g.label}
          </div>
          <div className="grid grid-cols-2 gap-0.5">
            {g.entries.map((e) => (
              <button
                key={e.name}
                onClick={() => onPick(e.name)}
                className="text-left px-1.5 py-0.5 text-[10px] text-gray-200 hover:bg-emerald-700/40 rounded font-mono truncate"
                title={e.name}
              >
                {e.itemLabel}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Build and visually verify**

```
npm run build
```

In the dev server:
1. Open a beatmap. The header now shows two stacked rows: tutorial timeline on top, scene timeline + `+ Scene` button below.
2. Click `+ Scene`, pick **Controller L → Primary glow**. A green band appears at the playhead with default duration 384 ticks. Drag it horizontally → moves. Drag the right edge → resizes. Click body → selected (lighter green). Press Backspace → deletes.
3. Pick **Hand indicator → Flash**. Renders as a thin spike (no resize handle).
4. Save. Re-open. Events round-trip. The chart on disk shows them under `[Events]`.

- [ ] **Step 7: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): scene-event timeline row + categorized picker"
```

---

## Task 9: Write the Unity engineer handover doc

**Files:**
- Create: `web/docs/SCENE_EVENTS.md`

- [ ] **Step 1: Write the handover doc**

Create `web/docs/SCENE_EVENTS.md` with the following content:

````markdown
# Scene Events — Engine Handover

**Owner:** chart authoring (web/frontend) → Unity engine (you)
**Last updated:** 2026-05-07

This doc describes the chart-side contract for **scene events** — a way for chart authors to drive Unity-side scene state from a song's `.chart` file. There are two kinds:

1. **Global flags** — set once at song load (crowd presence, laser cluster intensity).
2. **Timeline events** — fire at specific ticks during playback (controller onboarding cues, hand indicator, highway, beatline).

Forward-compat is the design constraint: both the editor and the engine must **ignore unknown keys/event names** so we can ship new ones without breaking old players.

---

## Storage format

### Global flags — `[Scene]` section

```chart
[Scene]
{
  floorcrowd = 0.1
  lasers_center = 0.2
  lasers_left = 0
  lasers_right = 0.1
}
```

- Plain `key = value` lines.
- Values are decimal numbers.
  - `0` = off
  - `0.1` = on (default intensity)
  - `0.2`, `0.3`, … = escalating intensity
- Decimal increments leave room for future intensity steps without renaming keys.
- Unknown keys: ignore at runtime. (The editor preserves them on round-trip so new flags survive an older editor.)
- Missing section: every flag defaults to `0`.

#### Defined flags

| Key | Effect | Example values |
|---|---|---|
| `floorcrowd` | Crowd presence on the floor | `0` off · `0.1` on · `0.2` on + intense |
| `lasers_center` | Center laser cluster | `0` / `0.1` / `0.2` / `0.3` (increasing intensity) |
| `lasers_left` | Left laser cluster | same scheme |
| `lasers_right` | Right laser cluster | same scheme |

### Timeline events — `[Events]` section

These piggy-back on the standard chart `[Events]` section that already carries section markers and lyrics:

```chart
[Events]
{
  0      = E "section Intro"
  36672  = E "onboard_L"
  36864  = E "onboard_L_primary 232"
  37056  = E "onboard_handindicator_flash"
  192000 = E "onboard_highway_show"
}
```

- Format: `<tick> = E "<payload>"`
- A scene-event payload is a single name token, optionally followed by a space and a duration in ticks:
  - `E "<name>"` — instantaneous trigger
  - `E "<name> <duration_ticks>"` — sustained effect; engine ends it at `tick + duration`
- A duration of `0` (or absent) means fire-and-forget.
- Unknown event names: ignore at runtime.
- Non-scene `[Events]` payloads (`section …`, `lyric …`, etc.) are unrelated and untouched.

---

## Event catalog

All names are lowercase, snake_case, prefixed `onboard_`. "Duration" column says whether the event accepts a non-zero duration.

### Controller — left hand (`onboard_L_*`)

| Event | Meaning | Duration |
|---|---|---|
| `onboard_L` | Show the left controller in the player's view | optional |
| `onboard_L_rotate` | Rotate the controller in place | optional |
| `onboard_L_primary` | Glow the primary face button | optional |
| `onboard_L_secondary` | Glow the secondary face button | optional |
| `onboard_L_menu` | Glow the menu button | optional |
| `onboard_L_trigger` | Glow the trigger | optional |
| `onboard_L_grip` | Glow the grip | optional |
| `onboard_L_thumbstick` | Glow the thumbstick | optional |
| `onboard_L_stickclick` | Glow the stick-click input | optional |

### Controller — right hand (`onboard_R_*`)

Mirrors the left side: `onboard_R`, `onboard_R_rotate`, `onboard_R_primary`, `onboard_R_secondary`, `onboard_R_menu`, `onboard_R_trigger`, `onboard_R_grip`, `onboard_R_thumbstick`, `onboard_R_stickclick`.

### Hand indicator (`onboard_handindicator_*`)

| Event | Meaning | Duration |
|---|---|---|
| `onboard_handindicator_show` | Show the hand-indicator overlay | optional |
| `onboard_handindicator_hide` | Hide the overlay | n/a |
| `onboard_handindicator_flash` | One-shot flash | n/a |

### Highway (`onboard_highway_*`)

| Event | Meaning | Duration |
|---|---|---|
| `onboard_highway_show` | Show the gameplay highway | optional |
| `onboard_highway_hide` | Hide the highway | n/a |

### Beatline (`onboard_beatline_*`)

| Event | Meaning | Duration |
|---|---|---|
| `onboard_beatline_show` | Show the beatline overlay | optional |
| `onboard_beatline_hide` | Hide the overlay | n/a |
| `onboard_beatline_flash` | One-shot flash on the current beat | n/a |
| `onboard_beatline_showsequence` | Begin a scripted highlight sequence | optional |
| `onboard_beatline_hidesequence` | End / cancel the sequence | n/a |

### Misc

| Event | Meaning | Duration |
|---|---|---|
| `onboard_controllerfretslide` | Demo the fret-slide gesture on the visible controller | optional |

---

## Suggested Unity architecture

A starting point — adapt to your codebase.

### `SceneState` (ScriptableObject)

Populated once at song load from `[Scene]`. One field per defined flag, plus a setter that clamps and notifies listeners.

```csharp
[CreateAssetMenu(menuName = "Beatmap/SceneState")]
public class SceneState : ScriptableObject
{
    public float Floorcrowd;
    public float LasersCenter;
    public float LasersLeft;
    public float LasersRight;

    public event Action OnApplied;

    public void ApplyFromChart(Dictionary<string, float> flags)
    {
        Floorcrowd   = flags.GetValueOrDefault("floorcrowd",     0f);
        LasersCenter = flags.GetValueOrDefault("lasers_center",  0f);
        LasersLeft   = flags.GetValueOrDefault("lasers_left",    0f);
        LasersRight  = flags.GetValueOrDefault("lasers_right",   0f);
        OnApplied?.Invoke();
    }
}
```

Crowd / laser controllers in the scene subscribe to `OnApplied` and re-read whichever fields they care about. New flags are added by extending this class — old controllers keep working.

### `SceneEventBus` (MonoBehaviour)

Pumped by the song clock. Holds `(tick, name, duration)` triples sorted by tick; on each playback tick, fires events whose `tick` is now ≤ playhead and that haven't already fired.

```csharp
public class SceneEventBus : MonoBehaviour
{
    private struct Cue { public int Tick; public string Name; public int Duration; }
    private List<Cue> _cues = new();
    private int _nextIndex;

    public event Action<string, int> OnEventFired; // (name, durationTicks)

    public void Load(IEnumerable<(int tick, string name, int duration)> cues)
    {
        _cues = cues.OrderBy(c => c.tick)
                    .Select(c => new Cue { Tick = c.tick, Name = c.name, Duration = c.duration })
                    .ToList();
        _nextIndex = 0;
    }

    public void Tick(int currentTick)
    {
        while (_nextIndex < _cues.Count && _cues[_nextIndex].Tick <= currentTick)
        {
            var cue = _cues[_nextIndex++];
            OnEventFired?.Invoke(cue.Name, cue.Duration);
        }
    }

    public void Reset() => _nextIndex = 0;
}
```

Per-category controllers subscribe to `OnEventFired` and switch on `name`:

```csharp
void OnEnable() => bus.OnEventFired += Handle;
void OnDisable() => bus.OnEventFired -= Handle;

private void Handle(string name, int duration)
{
    switch (name)
    {
        case "onboard_L":
        case "onboard_R":
            ShowController(name, duration);
            break;
        case "onboard_handindicator_flash":
            FlashHandIndicator();
            break;
        // … etc.
        default:
            // unknown name — ignore (forward compat)
            break;
    }
}
```

### Duration handling

For events with `duration > 0`, the receiver schedules the matching "end" effect at `currentTick + duration`. The simplest implementation is a helper on the controller:

```csharp
private void ShowController(string name, int durationTicks)
{
    SetVisible(name, true);
    if (durationTicks > 0)
    {
        StartCoroutine(HideAfterTicks(name, durationTicks));
    }
}
```

What "end" means is up to the receiver: a glow fades back out, a panel hides, a rotation reverses, etc.

### Forward compatibility

- Unknown names: log a `Debug.Log` once with the unknown name (so we notice in dev), then ignore.
- Unknown keys in `[Scene]`: ignore silently.
- Don't bake the catalog into the engine as an enum — keep it string-keyed so chart authors can add new events without an engine rebuild.

---

## Where the chart authoring lives

- Format spec: this doc.
- Editor that produces these files: `web/frontend/src/components/BeatmapEditor.tsx` (right sidebar `Scene` card + scene timeline row).
- Pure parsers/serializers: `web/frontend/src/components/sceneEvents.ts` (canonical list of known event names lives in `SCENE_EVENT_CATALOG`).

If you find an event you'd like to handle but it isn't in the catalog yet, add it to `sceneEvents.ts` and ping chart authoring — the editor picker auto-derives from that constant.
````

- [ ] **Step 2: Commit**

```
git add web/docs/SCENE_EVENTS.md
git commit -m "docs: scene-events handover for the Unity engineer"
```

---

## Task 10: Final round-trip verification + push + deploy

**Files:** none (verification + deployment only)

- [ ] **Step 1: Full round-trip smoke test**

In the dev server with backend running:

1. Open an existing beatmap that already has `[Events]` section markers.
2. Set every scene flag to a non-zero value (`0.1`, `0.2`, `0.3`, `0.1`).
3. Add three scene events: `onboard_L_primary` (drag right edge to ~500 ticks), `onboard_handindicator_flash` (instant), `onboard_highway_show` (default 384).
4. Save.
5. Inspect the `notes.chart` file on disk:
   - `[Scene]` block exists with the four lines.
   - `[Events]` block contains the original section markers AND the three new `E "onboard_*"` lines, sorted by tick.
6. Reload the editor. All scene flags + events come back with the right values and durations.
7. Save again without changes. Diff the file against the previous save: it should be **byte-identical** (no churn from re-serialization).

- [ ] **Step 2: Build the production bundle locally**

From `web/frontend/`:

```
npm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 3: Push to origin**

```
git push origin main
```

- [ ] **Step 4: Deploy to the droplet**

```
ssh -i ~/.ssh/id_ed25519_beatmap root@beatmap.jamsesh.co \
  'cd /opt/madmom && git pull --ff-only && cd web/frontend && npm ci --silent && npm run build && systemctl restart beatmap-backend && systemctl is-active beatmap-backend'
```

Expected: `active` printed at the end.

- [ ] **Step 5: Smoke-test on prod**

Open `https://beatmap.jamsesh.co/?id=<a-real-track>` → into a beatmap → confirm the new Scene sidebar card and scene timeline row are present and functional.
