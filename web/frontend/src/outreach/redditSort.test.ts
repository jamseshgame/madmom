import { describe, expect, it } from 'vitest'

import { filterRows, RedditRow, sortRows } from './redditSort'

function row(p: Partial<RedditRow>): RedditRow {
  return {
    name: 'r/test',
    url: 'https://www.reddit.com/r/test/',
    category: 'VR-Game',
    subscribers: 0,
    subscribers_approx: false,
    self_promo_verdict: 'Unknown',
    self_promo_detail: '',
    discord: null,
    description: '',
    custom: false,
    status: 'Not posted',
    last_posted: null,
    notes: '',
    ...p,
  }
}

describe('sortRows', () => {
  it('sorts subscribers numerically, not lexically', () => {
    const rows = [
      row({ name: 'r/a', subscribers: 9 }),
      row({ name: 'r/b', subscribers: 100 }),
      row({ name: 'r/c', subscribers: 20 }),
    ]
    expect(sortRows(rows, 'subscribers', 'asc').map((r) => r.subscribers)).toEqual([9, 20, 100])
    expect(sortRows(rows, 'subscribers', 'desc').map((r) => r.subscribers)).toEqual([100, 20, 9])
  })

  it('ranks verdict by posting-freedom, best first when ascending', () => {
    const rows = [
      row({ name: 'r/a', self_promo_verdict: 'Banned' }),
      row({ name: 'r/b', self_promo_verdict: 'Allowed' }),
      row({ name: 'r/c', self_promo_verdict: 'ModApproval' }),
    ]
    expect(sortRows(rows, 'self_promo_verdict', 'asc').map((r) => r.self_promo_verdict)).toEqual([
      'Allowed',
      'ModApproval',
      'Banned',
    ])
  })

  it('sorts never-posted rows last in ascending last_posted', () => {
    const rows = [
      row({ name: 'r/a', last_posted: null }),
      row({ name: 'r/b', last_posted: '2026-01-01' }),
      row({ name: 'r/c', last_posted: '2026-06-01' }),
    ]
    expect(sortRows(rows, 'last_posted', 'asc').map((r) => r.name)).toEqual(['r/b', 'r/c', 'r/a'])
  })

  it('breaks ties by name and does not mutate the input', () => {
    const rows = [
      row({ name: 'r/z', subscribers: 5 }),
      row({ name: 'r/a', subscribers: 5 }),
    ]
    const out = sortRows(rows, 'subscribers', 'asc')
    expect(out.map((r) => r.name)).toEqual(['r/a', 'r/z'])
    expect(rows.map((r) => r.name)).toEqual(['r/z', 'r/a']) // original untouched
  })
})

describe('filterRows', () => {
  const rows = [
    row({ name: 'r/beatsaber', category: 'VR-Rhythm', description: 'rhythm game' }),
    row({ name: 'r/virtualreality', category: 'VR-Game', notes: 'posted trailer' }),
  ]

  it('filters by category', () => {
    expect(filterRows(rows, '', 'VR-Rhythm').map((r) => r.name)).toEqual(['r/beatsaber'])
  })

  it('matches query across name, description, detail and notes', () => {
    expect(filterRows(rows, 'trailer', null).map((r) => r.name)).toEqual(['r/virtualreality'])
    expect(filterRows(rows, 'beat', null).map((r) => r.name)).toEqual(['r/beatsaber'])
  })

  it('returns everything on empty query and null category', () => {
    expect(filterRows(rows, '', null)).toHaveLength(2)
  })
})
