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

// One scene cue on the timeline. Two parameter shapes coexist:
//   • duration  — encoded in the `duration` field, written as `name <ticks>`.
//   • everything else (hex/number/enum) — encoded as the raw `value` token,
//     written as `name <value>`.
// At most one of `duration` and `value` is non-empty per event.
export interface SceneEvent {
  id: string         // ephemeral; regenerated per parse
  tick: number
  name: string       // e.g. "onboard_L_primary" or a custom "leftlasercolour"
  duration: number   // ticks; 0 = no duration token
  value: string      // raw parameter token for non-duration param types; '' if none
}

export type SceneEventGroup =
  | 'controllers_l'
  | 'controllers_r'
  | 'hand'
  | 'highway'
  | 'beatline'
  | 'scene'
  | 'misc'
  | 'custom'

// What the editor renders for the value input + how the chart payload after
// the event name should be parsed. `none` means no parameter; the cue fires
// as a bare `<tick> = E "name"` line.
export type SceneEventParam =
  | { type: 'none' }
  | { type: 'duration' }
  | { type: 'hex_color' }
  | { type: 'number'; min?: number; max?: number; step?: number }
  | { type: 'enum'; options: string[] }

export interface SceneEventCatalogEntry {
  name: string
  group: SceneEventGroup
  groupLabel: string
  itemLabel: string       // human-readable label for the picker
  description: string     // hover-tip / handover-doc copy; freeform
  param: SceneEventParam
  builtin?: boolean       // true for entries shipped with the editor
}

// Convenience accessor — tells the canvas whether to draw a resize handle.
export function entryAcceptsDuration(e: SceneEventCatalogEntry): boolean {
  return e.param.type === 'duration'
}

// Builtin catalog. Custom user-registered types are merged on top at runtime
// (see useCustomSceneEventTypes in BeatmapEditor.tsx).
export const SCENE_EVENT_CATALOG: SceneEventCatalogEntry[] = [
  // Controllers L
  { name: 'onboard_L',             group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Show controller',     description: 'Reveal the left controller model — pairs with `onboard_R` for full handset onboarding.',    param: { type: 'duration' }, builtin: true },
  { name: 'onboard_L_rotate',      group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Rotate',              description: 'Animate the left controller through a rotation cycle to demonstrate orientation.',          param: { type: 'duration' }, builtin: true },
  { name: 'onboard_L_primary',     group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Primary glow',        description: 'Pulse the primary face button on the left controller.',                                       param: { type: 'duration' }, builtin: true },
  { name: 'onboard_L_secondary',   group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Secondary glow',      description: 'Pulse the secondary face button on the left controller.',                                     param: { type: 'duration' }, builtin: true },
  { name: 'onboard_L_menu',        group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Menu glow',           description: 'Pulse the menu button on the left controller.',                                               param: { type: 'duration' }, builtin: true },
  { name: 'onboard_L_trigger',     group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Trigger glow',        description: 'Pulse the trigger highlight on the left controller — used for strum-trigger tutorials.',     param: { type: 'duration' }, builtin: true },
  { name: 'onboard_L_grip',        group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Grip glow',           description: 'Pulse the grip highlight on the left controller.',                                            param: { type: 'duration' }, builtin: true },
  { name: 'onboard_L_thumbstick',  group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Thumbstick glow',     description: 'Pulse the thumbstick highlight on the left controller.',                                      param: { type: 'duration' }, builtin: true },
  { name: 'onboard_L_stickclick',  group: 'controllers_l', groupLabel: 'Controller L', itemLabel: 'Stick-click glow',    description: 'Pulse the thumbstick-click highlight on the left controller.',                                param: { type: 'duration' }, builtin: true },
  // Controllers R
  { name: 'onboard_R',             group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Show controller',     description: 'Reveal the right controller model — pairs with `onboard_L` for full handset onboarding.',    param: { type: 'duration' }, builtin: true },
  { name: 'onboard_R_rotate',      group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Rotate',              description: 'Animate the right controller through a rotation cycle.',                                      param: { type: 'duration' }, builtin: true },
  { name: 'onboard_R_primary',     group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Primary glow',        description: 'Pulse the primary face button on the right controller.',                                      param: { type: 'duration' }, builtin: true },
  { name: 'onboard_R_secondary',   group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Secondary glow',      description: 'Pulse the secondary face button on the right controller.',                                    param: { type: 'duration' }, builtin: true },
  { name: 'onboard_R_menu',        group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Menu glow',           description: 'Pulse the menu button on the right controller.',                                              param: { type: 'duration' }, builtin: true },
  { name: 'onboard_R_trigger',     group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Trigger glow',        description: 'Pulse the trigger highlight on the right controller.',                                        param: { type: 'duration' }, builtin: true },
  { name: 'onboard_R_grip',        group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Grip glow',           description: 'Pulse the grip highlight on the right controller.',                                           param: { type: 'duration' }, builtin: true },
  { name: 'onboard_R_thumbstick',  group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Thumbstick glow',     description: 'Pulse the thumbstick highlight on the right controller.',                                     param: { type: 'duration' }, builtin: true },
  { name: 'onboard_R_stickclick',  group: 'controllers_r', groupLabel: 'Controller R', itemLabel: 'Stick-click glow',    description: 'Pulse the thumbstick-click highlight on the right controller.',                               param: { type: 'duration' }, builtin: true },
  // Hand indicator
  { name: 'onboard_handindicator_show',  group: 'hand', groupLabel: 'Hand indicator', itemLabel: 'Show',  description: 'Reveal the floating hand-position indicator. Pair with `_hide` to dismiss.',           param: { type: 'duration' }, builtin: true },
  { name: 'onboard_handindicator_hide',  group: 'hand', groupLabel: 'Hand indicator', itemLabel: 'Hide',  description: 'Dismiss the hand-position indicator.',                                                  param: { type: 'none' },     builtin: true },
  { name: 'onboard_handindicator_flash', group: 'hand', groupLabel: 'Hand indicator', itemLabel: 'Flash', description: 'One-shot flash to draw the player\'s eye to the hand indicator without leaving it on.', param: { type: 'none' },     builtin: true },
  // Highway
  { name: 'onboard_highway_show', group: 'highway', groupLabel: 'Highway', itemLabel: 'Show', description: 'Bring the note highway into view — used after intros / interludes when notes resume.', param: { type: 'duration' }, builtin: true },
  { name: 'onboard_highway_hide', group: 'highway', groupLabel: 'Highway', itemLabel: 'Hide', description: 'Dismiss the highway. Useful for cinematic moments when notes shouldn\'t be visible.', param: { type: 'none' },     builtin: true },
  // Beatline
  { name: 'onboard_beatline_show',         group: 'beatline', groupLabel: 'Beatline', itemLabel: 'Show',          description: 'Show the strike line at the bottom of the highway.',                              param: { type: 'duration' }, builtin: true },
  { name: 'onboard_beatline_hide',         group: 'beatline', groupLabel: 'Beatline', itemLabel: 'Hide',          description: 'Hide the strike line.',                                                            param: { type: 'none' },     builtin: true },
  { name: 'onboard_beatline_flash',        group: 'beatline', groupLabel: 'Beatline', itemLabel: 'Flash',         description: 'One-shot flash of the strike line — typically aligned to a downbeat accent.',     param: { type: 'none' },     builtin: true },
  { name: 'onboard_beatline_showsequence', group: 'beatline', groupLabel: 'Beatline', itemLabel: 'Show sequence', description: 'Begin a sequence of strike-line pulses synced to the underlying beat.',           param: { type: 'duration' }, builtin: true },
  { name: 'onboard_beatline_hidesequence', group: 'beatline', groupLabel: 'Beatline', itemLabel: 'Hide sequence', description: 'End an in-progress strike-line pulse sequence.',                                   param: { type: 'none' },     builtin: true },
  // Scene FX — formerly song-wide [Scene] flags. Now tick-based bursts so the
  // crowd / lasers can pulse with the song instead of holding one intensity
  // for the whole track.
  { name: 'onboard_floorcrowd',    group: 'scene', groupLabel: 'Scene FX', itemLabel: 'Floor crowd',     description: 'Trigger the audience floor-crowd reaction (cheers + body motion) for the duration.', param: { type: 'duration' }, builtin: true },
  { name: 'onboard_lasers_center', group: 'scene', groupLabel: 'Scene FX', itemLabel: 'Lasers · center', description: 'Activate the centre laser bank in the stage rig.',                                       param: { type: 'duration' }, builtin: true },
  { name: 'onboard_lasers_left',   group: 'scene', groupLabel: 'Scene FX', itemLabel: 'Lasers · left',   description: 'Activate the left laser bank in the stage rig.',                                         param: { type: 'duration' }, builtin: true },
  { name: 'onboard_lasers_right',  group: 'scene', groupLabel: 'Scene FX', itemLabel: 'Lasers · right',  description: 'Activate the right laser bank in the stage rig.',                                        param: { type: 'duration' }, builtin: true },
  // Misc
  { name: 'onboard_controllerfretslide', group: 'misc', groupLabel: 'Misc', itemLabel: 'Controller fret slide', description: 'Animate a slide between fret positions on the controller — visual hint for slide notes.', param: { type: 'duration' }, builtin: true },
]

const KNOWN_SCENE_EVENT_NAMES = new Set(SCENE_EVENT_CATALOG.map((e) => e.name))

export function isKnownSceneEventName(name: string): boolean {
  return KNOWN_SCENE_EVENT_NAMES.has(name)
}

export function findCatalogEntry(name: string, extra: SceneEventCatalogEntry[] = []): SceneEventCatalogEntry | undefined {
  return extra.find((e) => e.name === name) ?? SCENE_EVENT_CATALOG.find((e) => e.name === name)
}

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

// ── Legacy flag → event migration ─────────────────────────────────────────
//
// Pre-Scene-FX-events charts encoded floor crowd / lasers as song-wide
// constants under [Scene]. The editor now treats them as tick-based scene
// events; this helper converts any non-zero legacy flag into a single event
// spanning tick 0 through `endTick`, and returns the flags with those keys
// zeroed so the SCENE section no longer round-trips them. Intensity is not
// preserved — the engine reads any active event as "on".

const FLAG_TO_EVENT_NAME: Record<keyof SceneFlags, string> = {
  floorcrowd: 'onboard_floorcrowd',
  lasers_center: 'onboard_lasers_center',
  lasers_left: 'onboard_lasers_left',
  lasers_right: 'onboard_lasers_right',
}

export function migrateLegacySceneFlags(
  flags: SceneFlags,
  endTick: number,
): { events: SceneEvent[]; clearedFlags: SceneFlags } {
  const events: SceneEvent[] = []
  const clearedFlags: SceneFlags = { ...flags }
  let n = 0
  for (const key of SCENE_FLAG_KEYS) {
    if (!flags[key] || flags[key] <= 0) continue
    events.push({
      id: `scene-migrated-${key}-${n++}`,
      tick: 0,
      name: FLAG_TO_EVENT_NAME[key],
      duration: Math.max(0, endTick),
      value: '',
    })
    clearedFlags[key] = 0
  }
  return { events, clearedFlags }
}

// ── [Events] payload parsing ───────────────────────────────────────────────
//
// Standard chart `[Events]` lines look like `<tick> = E "<payload>"`. The
// payload is whatever the engine wants. We claim payloads that begin with
// `onboard_` — and any registered custom event name — optionally followed
// by a single value token. The token is parsed as a numeric duration when
// it's all digits; otherwise it's stored verbatim as `value` (e.g. a hex
// colour `#FF8800` or an enum option `slow`).
//
//   36864 = E "onboard_L_primary 232"          → duration=232
//   192000 = E "onboard_highway_show"          → no parameter
//   3840 = E "leftlasercolour #FF8800"         → value="#FF8800"
//
// All other E-lines (section/lyric markers, etc.) are NOT touched: we keep
// them verbatim in the passthrough text returned by parseSceneEvents.

const SCENE_EVENT_LINE = /^\s*(\d+)\s*=\s*E\s+"([^"]*)"\s*$/
// name is greedy on identifier chars; value is "the rest" minus surrounding
// whitespace, so hex colours and enum strings round-trip cleanly.
const SCENE_PAYLOAD = /^([A-Za-z][A-Za-z0-9_]*)(?:\s+(\S.*))?$/

export interface ParsedSceneEvents {
  events: SceneEvent[]
  // Lines from [Events] that we did NOT claim. Re-emitted verbatim on save.
  passthroughLines: string[]
  // True if the chart originally had an [Events] section at all. Determines
  // whether we re-emit the section even when both events and passthroughLines
  // are empty (we don't, in that case).
  hadSection: boolean
}

export function parseSceneEvents(
  text: string,
  customNames: Set<string> = new Set(),
): ParsedSceneEvents {
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
    const name = pm?.[1] ?? ''
    const isOurs = name.startsWith('onboard_') || customNames.has(name)
    if (!pm || !isOurs) {
      passthroughLines.push(stripped.trimEnd())
      continue
    }
    const valueTok = (pm[2] || '').trim()
    const numericOnly = /^\d+$/.test(valueTok)
    events.push({
      id: `scene-${tick}-${counter++}`,
      tick,
      name,
      duration: numericOnly ? Number(valueTok) : 0,
      value: numericOnly ? '' : valueTok,
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
      // duration takes precedence; otherwise the raw value token; otherwise
      // bare. Both fields can never be set at once via the editor UI.
      let suffix = ''
      if (e.duration > 0) suffix = ` ${e.duration}`
      else if (e.value) suffix = ` ${e.value}`
      return `  ${e.tick} = E "${e.name}${suffix}"`
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
