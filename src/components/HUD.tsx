import { useEffect, useState, CSSProperties } from 'react';
import { useStore } from '../sim/store';

/**
 * Heads-up display — restyled cozier than the original dev-tools
 * look. Soft semi-transparent ink cards in a warm tan palette; the
 * top-left shows battery + state in German micro-text (same as
 * before, but quieter); the top-right shows a time-of-day icon
 * (◐ dawn → ○ noon → ◑ dusk → ● night) and FPS; the bottom-right
 * has the two scene toggles.
 */

const STATE_LABEL: Record<string, string> = {
  IDLE: 'wartet',
  RAKE: 'harkt',
  SEEK_HOME: 'sucht heimleitung',
  DOCK: 'lädt',
};

// Time-of-day cycle: 0 = dawn, 0.25 = noon, 0.5 = dusk, 0.75 = night.
// Map to a symbol + a friendly label (English, kept short).
function phaseFromCycle(t: number): { glyph: string; label: string } {
  const u = ((t % 1) + 1) % 1;
  if (u < 0.125) return { glyph: '◐', label: 'dawn' };
  if (u < 0.375) return { glyph: '○', label: 'noon' };
  if (u < 0.625) return { glyph: '◐', label: 'noon' };
  if (u < 0.875) return { glyph: '◑', label: 'dusk' };
  return { glyph: '●', label: 'night' };
}

// Cleaner mapping by direct phase index.
function phaseSymbol(t: number): { glyph: string; label: string } {
  const u = ((t % 1) + 1) % 1;
  // 4 keyframes equally spaced at 0, 0.25, 0.5, 0.75.
  const idx = Math.round(u * 4) % 4;
  switch (idx) {
    case 0:
      return { glyph: '◐', label: 'dawn' };
    case 1:
      return { glyph: '○', label: 'noon' };
    case 2:
      return { glyph: '◑', label: 'dusk' };
    case 3:
    default:
      return { glyph: '●', label: 'night' };
  }
}

export function HUD() {
  const battery = useStore((s) => s.battery);
  const state = useStore((s) => s.state);
  const showGarden = useStore((s) => s.showGarden);
  const toggleGarden = useStore((s) => s.toggleGarden);
  const soundEnabled = useStore((s) => s.soundEnabled);
  const toggleSound = useStore((s) => s.toggleSound);
  const cycleT = useStore((s) => s.cycleT);
  const [fps, setFps] = useState(60);

  useEffect(() => {
    let last = performance.now();
    let frames = 0;
    let raf = 0;
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last > 500) {
        setFps(Math.round((frames * 1000) / (now - last)));
        last = now;
        frames = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Silence unused helper to avoid lint warnings (keep available for
  // future tweaks of the phase resolution).
  void phaseFromCycle;

  const pct = Math.round(battery);
  const batteryColor =
    battery > 30 ? '#3ad97e' : battery > 15 ? '#e8b53a' : '#e85a3a';
  const phase = phaseSymbol(cycleT);

  return (
    <>
      {/* Top-left: battery pill */}
      <div style={topLeft}>
        <div style={inkCard}>
          <div style={batteryOuter}>
            <div
              style={{
                ...batteryInner,
                width: `${pct}%`,
                background: batteryColor,
              }}
            />
          </div>
          <div style={textCol}>
            <div style={{ fontWeight: 600, fontSize: 13, lineHeight: 1 }}>
              {pct}%
            </div>
            <div style={subText}>{STATE_LABEL[state] ?? state}</div>
          </div>
        </div>
      </div>

      {/* Top-right: time of day + FPS */}
      <div style={topRight}>
        <div style={inkCard}>
          <span
            style={{
              fontSize: 18,
              lineHeight: 1,
              opacity: 0.9,
            }}
            aria-hidden
          >
            {phase.glyph}
          </span>
          <div style={textCol}>
            <div style={{ fontWeight: 600, fontSize: 12, lineHeight: 1 }}>
              {phase.label}
            </div>
            <div style={subText}>{fps} fps</div>
          </div>
        </div>
      </div>

      {/* Bottom-right: scene toggles */}
      <button
        type="button"
        onClick={toggleGarden}
        style={{ ...toggleBtn, ...gardenToggle, opacity: showGarden ? 1 : 0.6 }}
        title="Toggle karesansui background pattern"
      >
        <span style={toggleDot(showGarden)} />
        枯山水
      </button>
      <button
        type="button"
        onClick={toggleSound}
        style={{ ...toggleBtn, ...soundToggle, opacity: soundEnabled ? 1 : 0.6 }}
        title="Toggle ambient music + wind"
      >
        <span style={toggleDot(soundEnabled)} />
        音效
      </button>
    </>
  );
}

// ---- styles ----

const INK_BG = 'rgba(40, 32, 24, 0.45)'; // warm tan ink card
const INK_TEXT = '#f3ead8';
const INK_TEXT_DIM = '#c9bda5';

const topLeft: CSSProperties = {
  position: 'absolute',
  top: 20,
  left: 20,
  pointerEvents: 'none',
};

const topRight: CSSProperties = {
  position: 'absolute',
  top: 20,
  right: 20,
  pointerEvents: 'none',
};

const inkCard: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 13px 7px 9px',
  background: INK_BG,
  color: INK_TEXT,
  borderRadius: 18,
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  fontFamily:
    "'Iowan Old Style', 'Hoefler Text', Georgia, 'Songti SC', serif",
  letterSpacing: 0.3,
};

const batteryOuter: CSSProperties = {
  width: 28,
  height: 13,
  borderRadius: 3,
  position: 'relative',
  overflow: 'hidden',
  background: 'rgba(0,0,0,0.45)',
  border: '1px solid rgba(255,255,255,0.18)',
};

const batteryInner: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  transition: 'width 0.3s, background 0.3s',
};

const textCol: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const subText: CSSProperties = {
  fontSize: 10,
  opacity: 0.78,
  color: INK_TEXT_DIM,
  marginTop: 1,
  letterSpacing: 0.4,
};

const toggleBtn: CSSProperties = {
  position: 'absolute',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 13px',
  background: INK_BG,
  color: INK_TEXT,
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 1.0,
  fontFamily:
    "'Iowan Old Style', 'Hoefler Text', Georgia, 'Songti SC', serif",
  borderRadius: 16,
  border: '1px solid rgba(255,255,255,0.10)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  cursor: 'pointer',
  pointerEvents: 'auto',
  transition: 'opacity 0.25s',
};

const gardenToggle: CSSProperties = {
  bottom: 20,
  right: 20,
};

const soundToggle: CSSProperties = {
  bottom: 60,
  right: 20,
};

const toggleDot = (on: boolean): CSSProperties => ({
  display: 'inline-block',
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: on ? '#a9d09a' : '#7a705e',
  boxShadow: on ? '0 0 5px #a9d09a' : 'none',
});
