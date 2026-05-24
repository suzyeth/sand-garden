# Sand Garden — Backlog

Ideas captured during the first build sprint that didn't ship. Sorted
by impact × cost; not committed to. Treat this as "future me, here's
what felt promising at the time."

---

## Weather depth

### Rain intensity tiers
Currently rain is one fixed visual. Split into three intensities:
- **drizzle** — sparse particles, slow fall, light wetness
- **rain** (current default)
- **downpour** — dense particles, faster fall, stronger ambient drop, deeper sand darkening

State machine could pick one of three when entering `rain` phase, weighted by mood / season.

### Rain audio
`audio.ts` has the wind layer; add a rain layer. Filtered white noise + occasional patter samples. Volume scales with `weatherIntensity`.

### Splash particles
Tiny additive ring sprites that spawn briefly at random ground points during heavy rain. ~30-50 splashes pooled, recycle when fade ends. Maybe ~0.3s lifetime each.

### Wet stones
Stones currently keep their dry matte look during rain. Add a wetness-driven roughness drop + slight darkening to `Stones.tsx` material (similar to how `SandPlane.tsx` reads `uWetness` now). Wet stones should pick up a subtle specular highlight.

### Ambient + fog tied to weather
Right now ambient color and fog are driven only by `cycleT` (day/night keyframes). Layer a weather darkening on top:
- `ambientLight.intensity *= (1 - weatherIntensity * 0.35)` during rain
- `fog.near / fog.far` pulled inward during rain (~half their daytime values)
- ambient color tinted cooler/grey when overcast

Same pattern as wetness uniform: read `store.weatherIntensity` in `App.tsx`'s `useFrame`, multiply.

---

## Charging dock redesign (garage feel)

The robot currently parks **next** to the home stone (0.85m offset). User feedback: feels too casual, "碰一下就完事了".

Options:
- **Garage**: home stone becomes a taller open-front structure. Robot drives **into** the opening, stops inside. Visual cues: short approach ramp, two side walls, open front. Needs `DOCK_POS` re-computation in `Robot.tsx` and `HomeStone.tsx` redesign.
- **Sunken slot**: a low rectangular depression in the engawa where the robot rolls down and parks; visible from iso angle as the robot "lowering" into the slot.
- **Contact pads**: keep current park-beside model, but add two glowing bronze contact pads on the home stone's front face that pulse when robot is docked.

Garage is the most expensive but the highest-impact for the "入库" feeling.

---

## Creatures

### Crickets (night audio only)
Pure audio addition — no visual. Layer in `audio.ts`:
- gate on `cycleT > 0.55` (matches fireflies)
- subtle chirp pattern, rate ~5/min
- volume scales with night depth (peak ~0.75-0.85)
Zero render cost, big atmospheric payoff.

### Frog
Sits on moss (home stone moss patch or central moss island). Occasional small hop (~10-15cm arc). Slow blink. Croaks during rain (audio). Day visibility, more active in `cloudy` weather.

### Sparrow / wagtail
Same lifecycle pattern as `Butterfly.tsx`: arrives from off-frame via Catmull-Rom, perches on a stone, sings briefly, departs. Smaller appearance interval than butterfly so it's a quieter event.

### Beetle
Slow walker on sand. Same etch + scuff pattern as Gecko but much slower and smaller. Visit cycle similar to Gecko but rarer.

---

## Dragonfly polish

### Softer fade at the cloudy → rain boundary
Currently dragonflies are visibility-gated on `weather === 'cloudy'` as a hard boolean. Once rain starts, they pop out instantly. Better: ease out over ~3 seconds when leaving cloudy, ease in over ~2 seconds when entering. Add `dragonflyFade` ref that lerps toward target.

### Different individual flight patterns
All current dragonflies share the same hover/dart FSM. Differentiate: one "patroller" (longer dashes), one "hoverer" (more freeze time). Adds character without adding count.

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
