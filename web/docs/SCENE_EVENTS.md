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
