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
