# Robot Karesansui

A small robot perpetually rakes wave patterns into a tiny dry garden. The rake doesn't know what it's drawing. Sand slowly forgets. Weather rolls in, dragonflies dart, fireflies come out at dusk, and the robot returns home to charge.

Inspired by [Robin Reiter's robot lawn mower zen garden](https://x.com/robin7331/status/2055913423968346439).

## Run

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>.

```bash
npm run build    # type-check + production build
npm run preview  # serve the production build locally
```

## What's in it

- **Karesansui sand sim** — heightfield with diffusion + drift; the robot's rake teeth etch a real groove that slowly fades. Concentric ripples around each stone are computed in-shader so the procedural pattern can be toggled live.
- **Battery FSM** — robot rakes a Catmull-Rom path, leaves to dock when low, charges, then resumes exactly where it stopped. Two-leg approach (waypoint → straight-in) keeps the chassis clear of the dock flanks.
- **Open-air charging dock** — wood-and-stone bay with bronze contact pads; a vertical additive light beam pulses during DOCK to make the charging legible.
- **Day/night cycle** (3-minute loop) — four lighting keyframes drive sky gradient, sun position, fog, ambient music tone, and creature presence windows.
- **Weather** — `clear → cloudy → rain → clearing` state machine. Rain phase picks one of three tiers (drizzle / moderate / heavy) that scale drop count, streak length, fall speed, wetness, splash density, and audio gain. Heavy rain forms puddles where the sand has been disturbed.
- **Wind** — shared uniforms drive a gust-based bamboo + leaf shader. Calm baseline + random gusts every 10-28s; the whole grove sways together when wind hits.
- **Fauna**
  - Butterfly: arrives via Catmull-Rom, perches on a stone, drifts away
  - Dragonflies: hover/dart FSM, two personalities (hoverer / patroller), only emerge in the pre-rain cloudy lull
  - Gecko: bursty crawler, etches a thin tail-tip trail, walks toward the nearest stone to "hide" before disappearing
  - Frog: sits on the central moss island, hops occasionally, pulses subtly during rain
  - Sparrow / wagtail: butterfly-style lifecycle with tail wag as the "song" cue
  - Beetle: slow sand-crosser with smaller etch and scuff trail
  - Fireflies: nocturnal swarm, occasionally perches on stone tops with a soft halo
- **Audio** — Suno-generated ambient music tracks crossfaded by time-of-day; synthesised wind, rain, cricket, and frog croak layers gated by weather and night weight. All synth; no extra sample files needed.

## Controls

Once the robot starts its rake path it drives itself. The only UI is the HUD overlay:

- **Battery / state card** (top-left) — current battery %, FSM state (rake / seek-home / dock), and a ⚡ pulse when charging
- **Time / weather cards** (top-right) — day-night phase, FPS, and current weather phase + rain tier
- **Toggles** (bottom-right)
  - 枯山水 — toggle the procedural concentric/parallel sand pattern (off = blank "scattered sand")
  - 音效 — toggle ambient music + wind + rain layers
  - 天气: \<state\> — debug cycle: `auto → clear → cloudy → drizzle → moderate → heavy → clearing → auto`. Forces weather phase + tier so you can see any state on demand.

## Stack

- Vite + React 18 + TypeScript
- `@react-three/fiber` (Three.js R3F) + `@react-three/drei`
- Web Audio API for the synthesised layers
- `zustand` for shared sim state

No backend, no asset pipeline. Bamboo, leaves, sand grain, stone shading, wood grain, puddles — all drawn in-shader on `MeshStandardMaterial` via `onBeforeCompile` injections.

## Project layout

```
src/
  App.tsx                  - SceneLighting (day/night/weather keyframes) + canvas
  components/
    Garden.tsx             - scene composition
    SandPlane.tsx          - heightfield + karesansui pattern shader + puddles
    Stones.tsx             - 4 main stones (icosahedron + displaced verts)
    HomeStone.tsx          - open-air charging dock + charge beam
    Robot.tsx              - chassis + rake + path follower + battery FSM
    Weather.tsx            - weather state machine + rain particles
    RainSplashes.tsx       - drop-impact dust puffs
    Periphery.tsx          - bamboo grove + leaves + shrubs + wind system
    StoneLantern.tsx       - tōrō with night-only emissive lamp
    Dragonflies / Frog / Sparrow / Beetle / Butterfly / Gecko / Fireflies / FallingLeaves
    BackWall.tsx           - L-shape clay wall backdrop
    HUD.tsx                - overlay UI
  sim/
    sandField.ts           - heightfield buffer + etch / diffuse / drift
    stones.ts              - stone positions (single source of truth)
    patterns.ts            - Catmull-Rom path generator
    audio.ts               - ambient + synth layers controller
    store.ts               - zustand store
    constants.ts           - shared world dimensions
```

## License

MIT. Use, fork, adapt freely.
