# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev       # vite dev server on :5173
npm run build     # tsc --noEmit + vite build (full type-check is the build's job)
npm run preview   # serve dist/
```

There is no test runner, linter, or formatter configured in this repo. `npm run build` is the only verification step — if it passes, types are clean.

To type-check without producing a bundle: `npx tsc --noEmit`.

## Architecture

### One scene, two systems describing the same image

The visible "karesansui rake pattern" is rendered by **two independent systems** that are deliberately aligned:

1. **`src/components/SandPlane.tsx`** — a flat plane whose fragment shader draws procedural concentric ripples around every stone (frequency `BG_FREQ_PER_METRE`, dark lines at `stone.radius + (2k+1) * 0.111`). This is the static background pattern.
2. **`src/sim/sandField.ts`** — a `Float32Array` heightfield (1024×1024, ~1.56 cm/cell over 16 m) uploaded as a `THREE.DataTexture`. The shader samples this and darkens fragments by height-gradient relief. This is where the robot's actual rake leaves marks.

`src/sim/patterns.ts` generates the robot's waypoint path *to overlap the shader's ripples on purpose* — the fresh trail aligns pixel-for-pixel with the bg pattern so it reads as "maintenance," not "drawing." If you change `BG_FREQ_PER_METRE` in `SandPlane.tsx`, you must update the ring radii (`k = 3, 5, 7, 9`) in `patterns.ts` or the alignment breaks.

`sandField` is a **module-level singleton** (`export const sandField = new SandField()`), not React state. `Robot.tsx` calls `sandField.etch(...)` every frame; `SandPlane.tsx` calls `sandField.tick()` at 10 Hz for drift/diffuse. The texture is mutated in place.

### Single sources of truth (cross-file invariants)

- **`src/sim/constants.ts`** — `SAND_SIZE`, `WALL_LIMIT`, `CHASSIS_SAFETY`. Imported by sand mesh, sand border, sand field UV mapping, and path generator. Change here, not at call sites.
- **`src/sim/stones.ts`** — every stone position, scale, and `rakeRadius` lives here. Consumed by `Stones.tsx` (rendering), `SandPlane.tsx` (shader uniform `SHADER_STONES`), and `patterns.ts` (path obstacles). `SHADER_STONES` is the flat list that includes `HOME_STONE_POS` — the home dock is treated as a stone for ripple/avoidance purposes.

### Global state via zustand

`src/sim/store.ts` (`useStore`) holds everything that crosses component boundaries: `battery`, robot FSM `state` (`IDLE` | `RAKE` | `SEEK_HOME` | `DOCK`), `robotPos`, `cycleT` (0..1 day/night position), `weather`, `weatherIntensity`, `rainType`, plus debug overrides `forceWeather` / `forceRainType`. Reads happen inside `useFrame` many times per second — that's why zustand was picked over React Context.

`toggleSound` is intentionally side-effecting: it must call `ambientAudio.enable()` / `disable()` in the same call stack as the user gesture, because the Web Audio `AudioContext` will only start under a direct user gesture.

### SceneLighting owns the atmosphere

`SceneLighting` in `src/App.tsx` owns the directional + ambient + hemisphere lights, the 1×256 CanvasTexture sky, and `scene.fog`. All four atmospheric values (sky / fog / dir / amb) are interpolated from the same `KEYFRAMES` array (dawn → noon → dusk → night) so they stay in lockstep. Rain modulates these on top via `weatherIntensity`.

Two different update cadences in this component:

- **Every frame:** directional-light position (otherwise shadows snap at dusk/dawn).
- **10 Hz (`SKY_UPDATE_HZ`):** colour interpolation, sky gradient redraw, fog update, store writes (`setCycleT`), audio mood (`ambientAudio.setTimeOfDay`).

If you touch the lighting code, preserve the day↔night handoff: the sun and moon arcs are designed so `ly` is continuous at `t = 0.5` and at the `t = 1.0` wrap. Breaking that re-introduces a visible "shadows suddenly get shorter at dusk" bug.

### Camera is fixed iso

`IsoCamera` is a `<OrthographicCamera makeDefault>` at `(20, 20, 20)` with `zoom={42}`. There is **no orbit control** — by design. drei's `<OrthographicCamera>` doesn't auto-orient toward origin, so `lookAt(0, 0, 0)` is called once in `useEffect`. If you swap to a different camera, you'll re-introduce the "staring at empty sky" bug.

### Robot path follower & battery FSM

`src/components/Robot.tsx` is the orchestrator. The path comes pre-tagged from `patterns.ts` (`'ring'` / `'transit-ring'` / `'transit-stone'`); the robot only reacts to flag changes (rake up on transit, +40% speed). Battery FSM:

- `RAKE → SEEK_HOME` when `battery < LOW_BATTERY_THRESHOLD` (18%).
- `SEEK_HOME → DOCK` after a two-leg approach (waypoint → straight-in) into `DOCK_POS`.
- `DOCK → RAKE` when `battery > CHARGED_THRESHOLD` (96%), after a settle/depart pause for visual ceremony.

The robot is **kinematic** — there's no physics body, despite `@react-three/rapier` being in `package.json` as a legacy dep. Don't try to wire Rapier back in unless that's a deliberate refactor.

### Weather → everything else

`Weather.tsx` runs the `clear → cloudy → rain → clearing` state machine and writes `weather`, `weatherIntensity`, `rainType` to the store. `weatherIntensity` is read by:

- `SceneLighting` (fog color/distance, dir+amb intensity drop)
- `Stones.tsx` (`uWetness` shader uniform → cool tint + roughness drop)
- `RainSplashes.tsx` (spawn rate `∝ intensity² × tier multiplier`)
- `ambientAudio.setWeatherIntensity` (rain layer gain)

The HUD's "天气: \<state\>" button cycles `forceWeather` / `forceRainType` so any state can be inspected on demand.

### Periphery, fauna, and the "everything in-shader" rule

Bamboo, leaves, sand grain, stone shading, wood grain, puddles are all drawn by `MeshStandardMaterial.onBeforeCompile` injections — there is **no asset pipeline**. The only external assets are `/audio/*.mp3`. Wind shares uniforms across `Periphery.tsx` (bamboo + leaves + shrubs) so the whole grove sways together.

Each fauna component (`Butterfly`, `Dragonflies`, `Gecko`, `Frog`, `Sparrow`, `Beetle`, `Fireflies`, `FallingLeaves`) is self-contained and reads only what it needs from `useStore` — they don't talk to each other.

## Project conventions worth knowing

- **Coordinate convention:** world is right-handed; `(x, z)` is the ground plane, `+y` is up. `sandField.worldToCell` maps world `(x, -z)` to UV `(0, 1)` — note the **z flip**. Any new producer of sand etches must use `sandField.etch(x, z, ...)` with world coords; the singleton handles the mapping.
- **Singletons over React state** for things that mutate every frame: `sandField`, `ambientAudio`. Wrapping them in `useState` would cause re-renders on every tick.
- **`patterns.ts` is evaluated at module load** — the waypoint path is a constant. If you change stone positions, the path is regenerated automatically on next dev-server restart.
- The `BACKLOG.md` "Decided NOT to do" section is load-bearing: items there were tried and rejected (multi-coloured dragonflies, multi-species leaves, pebble border, layered chassis robot). Don't re-propose them without reading the entry first.
