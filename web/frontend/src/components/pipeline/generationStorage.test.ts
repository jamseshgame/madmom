import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadStoredGeneration, saveStoredGeneration, STORAGE_KEY } from './generationStorage'
import { GENERATION_DEFAULTS } from './generationTypes'

// ---------------------------------------------------------------------------
// Minimal localStorage shim for node environment (no jsdom required).
// We build a plain object whose `setItem` is a configurable property so the
// quota-error test can override it via Storage.prototype.setItem (we point
// Storage.prototype at the same object).
// ---------------------------------------------------------------------------
let _store: Record<string, string> = {}

const shimInstance = {
  getItem: (key: string) => (key in _store ? _store[key] : null),
  setItem: (key: string, value: string) => { _store[key] = value },
  removeItem: (key: string) => { delete _store[key] },
  clear: () => { _store = {} },
  get length() { return Object.keys(_store).length },
  key: (index: number) => Object.keys(_store)[index] ?? null,
}

vi.stubGlobal('localStorage', shimInstance)
// Expose a Storage global with a writable prototype so the quota-error test
// can temporarily replace Storage.prototype.setItem and have that affect
// our shimInstance (which is also Storage.prototype).
const StorageShim = { prototype: shimInstance }
vi.stubGlobal('Storage', StorageShim)

describe('generationStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns defaults when no entry stored', () => {
    const { generation, activePreset } = loadStoredGeneration()
    expect(generation).toEqual(GENERATION_DEFAULTS)
    expect(activePreset).toBe('v1')
  })

  it('round-trips a stored value', () => {
    const custom = {
      ...GENERATION_DEFAULTS,
      onsets: { engine: 'aubio-onset', params: { threshold: 0.4 } },
    }
    saveStoredGeneration(custom, 'v4 — chord-heavy')
    const out = loadStoredGeneration()
    expect(out.generation).toEqual(custom)
    expect(out.activePreset).toBe('v4 — chord-heavy')
  })

  it('falls back to defaults when stored JSON is malformed', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    const { generation, activePreset } = loadStoredGeneration()
    expect(generation).toEqual(GENERATION_DEFAULTS)
    expect(activePreset).toBe('v1')
  })

  it('falls back to defaults when stored value is missing keys', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ generation: { onsets: { engine: 'aubio-onset', params: {} } } }))
    const { generation, activePreset } = loadStoredGeneration()
    // Missing stages get filled with defaults so the UI doesn't crash on
    // partial state shipped from an older version of the app.
    expect(generation.pitches).toEqual(GENERATION_DEFAULTS.pitches)
    expect(generation.lanes_expert).toEqual(GENERATION_DEFAULTS.lanes_expert)
    expect(generation.onsets).toEqual({ engine: 'aubio-onset', params: {} })
    expect(activePreset).toBe('v1')
  })

  it('save followed by clear-and-reload returns defaults', () => {
    saveStoredGeneration(GENERATION_DEFAULTS, 'v2 — tonal (key-relative)')
    localStorage.clear()
    const { generation, activePreset } = loadStoredGeneration()
    expect(generation).toEqual(GENERATION_DEFAULTS)
    expect(activePreset).toBe('v1')
  })

  it('saveStoredGeneration tolerates localStorage quota errors silently', () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      expect(() => saveStoredGeneration(GENERATION_DEFAULTS, 'v1')).not.toThrow()
    } finally {
      Storage.prototype.setItem = original
    }
  })
})
