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
