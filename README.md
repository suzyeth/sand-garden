# Robot Karesansui

A small robot perpetually rakes wave patterns into a tiny sand garden. The rake doesn't know what it's drawing. Sand slowly forgets.

Inspired by [Robin Reiter's robot lawn mower zen garden](https://x.com/robin7331/status/2055913423968346439).

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:5173

## Controls (N1 only — robot will drive itself from N3 onwards)

| Key | Action |
| --- | --- |
| W / ↑ | Forward |
| S / ↓ | Back |
| A / ← | Turn left |
| D / → | Turn right |

## Roadmap

- **N1 (current)** — isometric scene + 5 stones + 1 home stone + keyboard-driven robot
- **N2** — sand heightfield + rake leaves visible trail + slow diffusion (sand "forgets")
- **N3** — pattern AI (spiral / concentric / parallel) + battery FSM + auto-dock
- **N4 (optional)** — polish, multiple patterns, soft audio, recording

## Stack

- Vite + React 18 + TypeScript
- `@react-three/fiber` (Three.js R3F)
- `@react-three/drei` (camera / utilities)
- `@react-three/rapier` (3D physics, real wheel friction)
- `zustand` (FSM + shared sim state)
