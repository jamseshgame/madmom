"""Chart analysis service — wraps analyse_chart_section and count_notes from JamseshMenu."""

import re
from collections import Counter, defaultdict
from pathlib import Path


PAIR_NAMES = {(0, 1): '0+1', (1, 2): '1+2', (2, 3): '2+3', (3, 4): '3+4'}


def analyse_chart_section(body: str) -> dict:
    """Parse a chart section body and return detailed note type counts."""
    note_events = defaultdict(list)
    slide_ticks = defaultdict(set)

    for line in body.strip().split('\n'):
        line = line.strip()
        if not line:
            continue
        m = re.match(r'(\d+)\s*=\s*N\s+(\d+)\s+(\d+)', line)
        if m:
            tick, fret, sustain = int(m.group(1)), int(m.group(2)), int(m.group(3))
            note_events[tick].append((fret, sustain))
            continue
        m = re.match(r'(\d+)\s*=\s*E\s+slide\s+(\d+)', line)
        if m:
            tick, fret = int(m.group(1)), int(m.group(2))
            slide_ticks[tick].add(fret)

    stats = {
        'singles': defaultdict(int),
        'holds': defaultdict(int),
        'chords': defaultdict(int),
        'chord_holds': defaultdict(int),
        'slides': defaultdict(int),
        'chord_slides': defaultdict(int),
        'open_normal': 0,
        'open_hold': 0,
        'open_slide': 0,
        'total_events': 0,
    }

    for tick, frets in slide_ticks.items():
        frets_sorted = sorted(frets)
        if len(frets_sorted) == 1:
            fret = frets_sorted[0]
            if fret == 7:
                stats['open_slide'] += 1
            else:
                stats['slides'][fret] += 1
        elif len(frets_sorted) == 2 and frets_sorted[1] - frets_sorted[0] == 1:
            pair = tuple(frets_sorted)
            stats['chord_slides'][pair] += 1
        else:
            for fret in frets_sorted:
                stats['slides'][fret] += 1
        stats['total_events'] += 1

    for tick, notes in note_events.items():
        frets_at_tick = sorted(set(f for f, _ in notes if 0 <= f <= 4))
        max_sustain = max(s for _, s in notes)
        is_hold = max_sustain > 0

        has_open = any(f == 7 for f, _ in notes)
        if has_open:
            if is_hold:
                stats['open_hold'] += 1
            else:
                stats['open_normal'] += 1
            stats['total_events'] += 1
            continue

        if len(frets_at_tick) == 1:
            fret = frets_at_tick[0]
            if is_hold:
                stats['holds'][fret] += 1
            else:
                stats['singles'][fret] += 1
            stats['total_events'] += 1
        elif len(frets_at_tick) == 2:
            pair = tuple(frets_at_tick)
            if is_hold:
                stats['chord_holds'][pair] += 1
            else:
                stats['chords'][pair] += 1
            stats['total_events'] += 1
        else:
            stats['total_events'] += 1

    return stats


def analyse_chart_file(content: str) -> dict:
    """Analyse a full .chart file, returning per-difficulty stats and metadata."""
    # Parse [Song] metadata
    song_match = re.search(r'\[Song\]\n\{([^}]*)\}', content)
    song_meta = {}
    if song_match:
        for line in song_match.group(1).strip().split('\n'):
            line = line.strip()
            if '=' in line:
                key, _, val = line.partition('=')
                song_meta[key.strip()] = val.strip().strip('"')

    song_name = song_meta.get('Name', 'Unknown')
    resolution = int(song_meta.get('Resolution', 192))

    # Parse BPM
    sync_match = re.search(r'\[SyncTrack\]\n\{([^}]*)\}', content)
    bpm = 0.0
    if sync_match:
        m = re.search(r'0 = B (\d+)', sync_match.group(1))
        if m:
            bpm = int(m.group(1)) / 1000.0

    # Per-difficulty stats
    all_sections = ['ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle']
    difficulties = {}

    for section in all_sections:
        match = re.search(r'\[' + section + r'\]\n\{([^}]*)\}', content)
        if not match:
            continue
        raw = analyse_chart_section(match.group(1))
        # Convert defaultdicts to regular dicts with string keys for JSON
        difficulties[section] = {
            'total_events': raw['total_events'],
            'singles': {str(k): v for k, v in raw['singles'].items()},
            'holds': {str(k): v for k, v in raw['holds'].items()},
            'chords': {f'{k[0]}+{k[1]}': v for k, v in raw['chords'].items()},
            'chord_holds': {f'{k[0]}+{k[1]}': v for k, v in raw['chord_holds'].items()},
            'slides': {str(k): v for k, v in raw['slides'].items()},
            'chord_slides': {f'{k[0]}+{k[1]}': v for k, v in raw['chord_slides'].items()},
            'open_normal': raw['open_normal'],
            'open_hold': raw['open_hold'],
            'open_slide': raw['open_slide'],
        }

    return {
        'song_name': song_name,
        'resolution': resolution,
        'bpm': bpm,
        'difficulties': difficulties,
    }
