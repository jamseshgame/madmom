// Pure chart-authoring rule checks + auto-cleanup for the beatmap editor.
//
// Authoring rules — enforced when committing edits:
//
//   R1: At most 2 gem notes (lanes 0–4) on a single tick. Open notes (lane 7)
//       are mutually exclusive with gems at the same tick and count as 1.
//   R2: A "chord" must be exactly aligned: any two gem notes in different lanes
//       within CHORD_NEAR ticks of each other must share a tick. This catches
//       near-miss authoring slip-ups (e.g. dragging a chord partner off by
//       1/32) without flagging legitimate fast runs at higher snap.
//
// Modifiers (lanes 5/6) attach to the underlying note and never count toward a
// chord. Slide-tagged notes are excluded from R1 — a slide is a sequential run,
// not a chord, so synthesised slide-start notes must not inflate the per-tick
// count and falsely block commits on unrelated edits.

/** Structural subset of ChartNote the rule logic needs. ChartNote (a superset)
 *  is assignable to this via structural typing. */
export interface RuleNote {
  tick: number
  lane: number // 0-4 colored frets, 5 force-hopo, 6 tap, 7 open
  slideId?: number
}

/** ≈ 1/16 beat — the near-miss window for R2. */
function chordNear(resolution: number): number {
  return Math.max(1, Math.round(resolution / 16))
}

// Pure check — returns null when the chart is clean, or a human-readable
// message describing the first violation found.
export function checkNoteRules(notes: RuleNote[], resolution: number): string | null {
  const CHORD_NEAR = chordNear(resolution)
  const tickLanes = new Map<number, number[]>()
  for (const n of notes) {
    if (n.lane > 4 && n.lane !== 7) continue
    if (n.slideId != null) continue // slides are runs, not chords
    const arr = tickLanes.get(n.tick)
    if (arr) arr.push(n.lane)
    else tickLanes.set(n.tick, [n.lane])
  }
  // R1: max 2 notes per tick. An open + any gem at the same tick is a
  // gameplay-conflict (open = full strum) → also flagged.
  for (const [tick, lanes] of tickLanes) {
    if (lanes.length > 2) {
      return `Max 2 notes per beat (tick ${tick} has ${lanes.length})`
    }
    if (lanes.length === 2 && lanes.includes(7)) {
      return `Open notes can't be chorded with gems (tick ${tick})`
    }
  }
  // R2: near-miss chord check. Walk gem notes in tick order — any two within
  // CHORD_NEAR ticks that are NOT at the same tick are a misaligned chord.
  const gems = notes
    .filter((n) => n.lane <= 4)
    .map((n) => ({ tick: n.tick, lane: n.lane }))
    .sort((a, b) => a.tick - b.tick)
  for (let i = 0; i < gems.length; i++) {
    for (let j = i + 1; j < gems.length; j++) {
      const a = gems[i],
        b = gems[j]
      const gap = b.tick - a.tick
      if (gap === 0) continue // same-tick chord — counted by R1
      if (gap >= CHORD_NEAR) break // sorted: nothing closer further on
      if (b.lane !== a.lane) {
        return `Chord notes must share a tick (ticks ${a.tick} and ${b.tick} are too close)`
      }
    }
  }
  return null
}

// Auto-clean a chart so it satisfies checkNoteRules, by REMOVING the minimal set
// of offending notes. Generic so the caller's full note type flows through.
//   R1  trim each tick to at most 2 gem/open notes; when an open (lane 7) shares
//       a tick with gems, drop the open (the individual gems carry more detail).
//   R2  drop the later of any two gems within CHORD_NEAR ticks that don't share
//       a tick (a misaligned chord partner).
// Returns the cleaned note array, or null when the chart is already clean.
export function autoCleanNotes<T extends RuleNote>(notes: T[], resolution: number): T[] | null {
  const CHORD_NEAR = chordNear(resolution)
  const remove = new Set<number>()
  // R1: group gem + open notes by tick (skip modifiers + slide-tagged notes,
  // exactly as checkNoteRules does).
  const byTick = new Map<number, number[]>()
  notes.forEach((n, i) => {
    if (n.lane > 4 && n.lane !== 7) return
    if (n.slideId != null) return
    const arr = byTick.get(n.tick)
    if (arr) arr.push(i)
    else byTick.set(n.tick, [i])
  })
  for (const idxs of byTick.values()) {
    const opens = idxs.filter((i) => notes[i].lane === 7)
    const gems = idxs.filter((i) => notes[i].lane <= 4)
    if (opens.length && gems.length) opens.forEach((i) => remove.add(i))
    const survivors = (gems.length ? gems : opens).filter((i) => !remove.has(i))
    const seenLane = new Set<number>()
    let kept = 0
    for (const i of survivors) {
      const lane = notes[i].lane
      if (seenLane.has(lane) || kept >= 2) {
        remove.add(i)
        continue
      }
      seenLane.add(lane)
      kept++
    }
  }
  // R2: walk surviving gems in tick order, dropping misaligned chord partners.
  const gems = notes
    .map((n, i) => ({ i, tick: n.tick, lane: n.lane }))
    .filter((g) => notes[g.i].lane <= 4 && !remove.has(g.i))
    .sort((a, b) => a.tick - b.tick)
  for (let a = 0; a < gems.length; a++) {
    if (remove.has(gems[a].i)) continue
    for (let b = a + 1; b < gems.length; b++) {
      if (remove.has(gems[b].i)) continue
      const gap = gems[b].tick - gems[a].tick
      if (gap === 0) continue
      if (gap >= CHORD_NEAR) break
      if (gems[b].lane !== gems[a].lane) remove.add(gems[b].i)
    }
  }
  if (remove.size === 0) return null
  return notes.filter((_, i) => !remove.has(i))
}

// How many notes autoCleanNotes would strip to make `notes` legal. The commit
// gate treats this as a monotone "dirtiness" score: an edit is allowed unless it
// raises the score (i.e. introduces a brand-new violation). A chart that arrives
// already dirty can therefore still be edited — and deleted out of — freely.
export function ruleRemovalCount(notes: RuleNote[], resolution: number): number {
  const cleaned = autoCleanNotes(notes, resolution)
  return cleaned ? notes.length - cleaned.length : 0
}
