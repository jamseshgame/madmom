"""Drive /generate-beatmap-v2 once per varied preset (v2..v11) against
one track + stem on the live droplet. Sequential — waits for each job
to finish before kicking off the next so the droplet's thread pool
doesn't get hammered by 10 librosa/CREPE/basic-pitch jobs at once."""
from __future__ import annotations

import argparse
import json
import sys
import time

import requests


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='https://beatmap.jamsesh.co')
    ap.add_argument('--username', default='admin')
    ap.add_argument('--password', default='SlayTheStage')
    ap.add_argument('--track-id', required=True)
    ap.add_argument('--stem', default='guitar')
    ap.add_argument('--presets', nargs='*', default=None,
                    help='Specific preset names; default = every non-v1 builtin')
    ap.add_argument('--timeout', type=int, default=300, help='per-job timeout seconds')
    args = ap.parse_args()

    s = requests.Session()
    r = s.post(f'{args.host}/api/auth/login',
               data={'username': args.username, 'password': args.password})
    r.raise_for_status()
    print(f'[auth] logged in as {args.username}')

    catalog = s.get(f'{args.host}/api/generation-presets').json()
    by_name = {p['name']: p for p in catalog}

    if args.presets:
        wanted = args.presets
    else:
        wanted = [p['name'] for p in catalog if p.get('builtin') and p['name'] != 'v1']

    track = s.get(f'{args.host}/api/tracks/{args.track_id}').json()
    print(f'[track] {track["id"]} = "{track["name"]}" by {track.get("artist") or "?"}')

    results: list[dict] = []
    for i, name in enumerate(wanted, start=1):
        preset = by_name.get(name)
        if not preset:
            print(f'[{i}/{len(wanted)}] !! preset {name!r} not found, skipping')
            continue

        gen = preset['generation']
        form: dict[str, str] = {
            'stem': args.stem,
            'name': f'{track["name"]} ({args.stem}) [{name}]',
            'artist': track.get('artist') or 'Unknown',
            'album': track.get('album') or 'Unknown',
            'genre': track.get('genre') or 'Unknown',
            'year': track.get('year') or '',
            'preset': name,
            'onsets_engine': gen['onsets']['engine'],
            'onsets_params': json.dumps(gen['onsets'].get('params') or {}),
            'pitches_engine': gen['pitches']['engine'],
            'pitches_params': json.dumps(gen['pitches'].get('params') or {}),
            'quantized_engine': gen['quantized']['engine'],
            'quantized_params': json.dumps(gen['quantized'].get('params') or {}),
            'lanes_engine': gen['lanes_expert']['engine'],
            'lanes_params': json.dumps(gen['lanes_expert'].get('params') or {}),
            'playability_engine': gen['lanes_filtered']['engine'],
            'playability_params': json.dumps(gen['lanes_filtered'].get('params') or {}),
        }

        print(f'\n[{i}/{len(wanted)}] {name}')
        print(f'  POST /generate-beatmap-v2 (lanes={gen["lanes_expert"]["engine"]} '
              f'play={gen["lanes_filtered"]["engine"]} pitch={gen["pitches"]["engine"]} '
              f'onset={gen["onsets"]["engine"]} quant={gen["quantized"]["engine"]})')

        t0 = time.time()
        resp = s.post(f'{args.host}/api/tracks/{args.track_id}/generate-beatmap-v2',
                      data=form)
        if not resp.ok:
            print(f'  [FAIL] HTTP {resp.status_code}: {resp.text[:200]}')
            results.append({'preset': name, 'status': 'failed-to-start',
                            'detail': resp.text[:200]})
            continue
        job_id = resp.json()['job_id']
        print(f'  job {job_id}')

        last_step = ''
        deadline = t0 + args.timeout
        while time.time() < deadline:
            j = s.get(f'{args.host}/api/jobs/{job_id}').json()
            step = j.get('step') or j.get('status') or ''
            pct = j.get('progress')
            msg = j.get('message') or ''
            if step != last_step:
                print(f'  . [{pct:>3}%] {step}: {msg[:60]}'.rstrip())
                last_step = step
            if j.get('status') in ('done', 'failed'):
                elapsed = time.time() - t0
                ok = j.get('status') == 'done'
                tag = '[OK]' if ok else '[FAIL]'
                print(f'  {tag} {j.get("status")} in {elapsed:.1f}s - {msg[:80]}')
                results.append({'preset': name, 'status': j.get('status'),
                                'job_id': job_id, 'elapsed_s': round(elapsed, 1)})
                break
            time.sleep(2)
        else:
            print(f'  [FAIL] timeout after {args.timeout}s')
            results.append({'preset': name, 'status': 'timeout', 'job_id': job_id})

    print('\n--- summary ---')
    for r in results:
        print(f'  {r.get("status"):>10}  {r.get("elapsed_s","?"):>6}s  {r["preset"]}')
    failed = [r for r in results if r.get('status') != 'done']
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
