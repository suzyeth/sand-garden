# Sand Garden — Backlog

Ideas captured during the first build sprint that didn't ship. Sorted
by impact × cost; not committed to. Treat this as "future me, here's
what felt promising at the time."

---

## Shipped (2026-05-24 sprint)

These were on the backlog and have since landed — kept here so a
future-me grepping for the feature lands in the right place.

- **Rain intensity tiers** — drizzle / moderate / heavy picked per
  rain phase, drives drop count, streak length, fall speed, opacity,
  splash density. `RAIN_PARAMS` in `Weather.tsx`; `RainType` in store.
- **Rain audio** — band-passed noise rain layer in `audio.ts`, gain
  driven by `setWeatherIntensity()` called from `Weather.tsx`.
- **Splash particles** — `RainSplashes.tsx`, 48-instance pool, spawn
  rate scales with intensity² × tier multiplier.
- **Wet stones** — `Stones.tsx` injects `uWetness` uniform that
  lowers roughness and tints cool. Driven from `store.weatherIntensity`.
- **Ambient + fog tied to weather** — `SceneLighting` in `App.tsx`
  multiplies dir/amb intensity and pulls fog planes by intensity.
- **Cricket night chirps** — synthesised AM chirps in `audio.ts`,
  scheduled while `nightWeight > 0.05`.
- **Dragonfly soft fade + personalities** — `weatherFade` lerps the
  group scale across the cloudy boundary; `Personality` ('hoverer'
  vs 'patroller') biases FSM probabilities.
- **Garage charging dock** — `HomeStone.tsx` redesigned as an open-
  front bay (back + 2 sides + roof + floor pad + contact pads + back-
  wall antenna). `DOCK_POS` shortened so the robot parks inside.
- **Frog on moss** — `Frog.tsx`, sits on the central moss island,
  hops occasionally, blinks, pulses subtly during rain.
- **Sparrow** — `Sparrow.tsx`, Butterfly-style Catmull-Rom lifecycle,
  tail wags during perch as the "song" cue.
- **Beetle** — `Beetle.tsx`, slow sand-crossing walker, etches a thin
  scrape behind it and disturbs rake grooves with smaller numbers
  than the gecko.

---

## Weather depth (still open)

### Cinematic rain hits
The current rain doesn't have lightning, distant thunder, or
puddles. Adding any of them risks tipping the karesansui tone into
something more theatrical — flag, don't implement, unless the user
specifically asks.

### Rain on stone vs sand differentiation
Splashes currently land identically on sand and stone. A pass-through
to spawn slightly bigger splashes (and a brief specular highlight)
when a drop hits a stone would read as the patter being heard
correctly, not as one uniform field.

---

## Creatures (still open)

### Frog croak audio
The frog visual is in (`Frog.tsx`) and pulses subtly during rain as
a vocal-sac suggestion, but there's no actual audio. Add a frog
croak layer in `audio.ts` — synthesised low burst on a triangle
oscillator with quick decay, gated on `weather === 'rain'` and
fired at ~12-20s intervals.

### More creature variety
With frog + sparrow + beetle in, the day cast is full. Next batch
ideas: a koi shadow under the central moss island (only visible at
midday angles), or a snail with an extra-long etch trail. Don't add
more flying things — the air is already busy with butterfly +
dragonflies + sparrow.

---

## Robot polish

### A different robot silhouette
The original boxy chassis was kept after the layered (wheels + solar panel) attempt was rejected. There's still room to improve — maybe a slightly chamfered top edge, or a single visible accent stripe — without going full "machine cosplay".

### Faster snap when near deep grooves
`SNAP_STRENGTH = 0.4` is conservative. Could ramp it to 0.6+ when the nearby groove is `> 0.5` depth (very old / well-established trail). Existing rings get reinforced even more cleanly.

---

## Visual layout (the unfinished aesthetics pass)

The big cleanup pass (SW emptied, single leaf species, dragonfly retoned) helped a lot. Still on the table:

- **NW decompression**: NW corner has Stone 1 + moss + dwarf shrubs + stone lantern stacked on each other. Move the lantern to the SW empty quadrant (where `ma` is currently), or to the engawa edge between two corners.
- **Bamboo cluster count**: 42 canes feels dense from the iso camera. Try 28 (drop 1-2 satellite clusters).
- **Moss locations**: moss appears in 5+ places. Pick 2 deliberate spots, remove rest.
- **Engawa pebbles**: file `SandEdgePebbles.tsx` exists but is no longer mounted in `Garden.tsx`. Decide: delete the file or re-mount with reduced count.

---

## Tech debt / nice-to-haves

- **HUD weather indicator**: show current `weather` phase in HUD so users can spot the "cloudy = dragonflies coming, rain incoming" cue without watching forever
- **HUD battery FSM state**: when robot is `SEEK_HOME` / `DOCK`, show in HUD so the docking ceremony is legible
- **Customizable cycle speed**: a slider somewhere (debug panel?) to speed up day/night × 3 for demos without code changes
- **Path drift visualization**: optional toggle to overlay the precomputed waypoint path on the sand for debugging
- **README screenshots**: take 3-4 good shots and embed in README so the repo browse experience matches the live site

---

## Decided NOT to do (don't re-litigate)

These came up but were rejected for the karesansui aesthetic:
- ❌ Multi-colored dragonflies (electric blue / crimson / violet / amber) — replaced with muted blue-grey palette
- ❌ Multiple leaf species rotating by cycleT (maple / sakura / generic) — single species (maple) chosen for botanical coherence
- ❌ Grass tufts in SW corner — removed for `ma` (negative space)
- ❌ Layered chassis robot with 4 wheels and solar panel — kept simple black box
- ❌ Sand-edge pebbles around the entire perimeter — clean sand boundary preferred

---

## Out-of-scope reminders

Things that came up but belong to other contexts:
- W22+ portfolio: this project could become a portfolio piece — needs a deploy URL (GitHub Pages or Vercel) and a polished landing
- Job-search assets: not appropriate to use this on resume directly (it's a hack, not a tools-programmer artefact), but the *snap-to-groove* + battery FSM are worth describing in a technical-blog post if interviewing for graphics / sim roles
