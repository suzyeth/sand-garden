import { create } from 'zustand';
import { ambientAudio } from './audio';

/**
 * Global sim state, exposed via zustand.
 *
 * Why zustand instead of context: we read from inside the R3F render loop
 * (useFrame) many times per second, and zustand's selectors don't trigger
 * the whole tree to re-render the way Context does.
 */

export type RobotState = 'IDLE' | 'RAKE' | 'SEEK_HOME' | 'DOCK';
// Weather phases — cycle: clear → cloudy → rain → clearing → clear.
// Dragonflies only emerge during 'cloudy' (the still-warm pre-rain
// lull). Rain particles render during 'rain' + tail of 'clearing'.
export type Weather = 'clear' | 'cloudy' | 'rain' | 'clearing';

type Store = {
  // robot
  battery: number; // 0..100
  state: RobotState;
  robotPos: [number, number, number];

  // scene
  showGarden: boolean;
  soundEnabled: boolean;
  // Day/night cycle position in [0, 1) — dawn=0, noon=0.25, dusk=0.5,
  // night=0.75. Updated by SceneLighting at ~5Hz.
  cycleT: number;
  // Weather phase + smoothed intensity 0..1 (used for rain visuals
  // ramp-up/down so the system isn't a binary switch).
  weather: Weather;
  weatherIntensity: number;

  // setters
  setBattery: (b: number) => void;
  setState: (s: RobotState) => void;
  setRobotPos: (p: [number, number, number]) => void;
  setCycleT: (t: number) => void;
  setWeather: (w: Weather) => void;
  setWeatherIntensity: (i: number) => void;
  toggleGarden: () => void;
  toggleSound: () => void;
};

export const useStore = create<Store>((set) => ({
  battery: 97,
  state: 'RAKE', // N1: we render RAKE so the HUD shows the right label
  robotPos: [0, 0, 0],
  showGarden: true,
  soundEnabled: false,
  cycleT: 0.25, // start at noon
  weather: 'clear',
  weatherIntensity: 0,

  setBattery: (battery) => set({ battery }),
  setState: (state) => set({ state }),
  setRobotPos: (robotPos) => set({ robotPos }),
  setCycleT: (cycleT) => set({ cycleT }),
  setWeather: (weather) => set({ weather }),
  setWeatherIntensity: (weatherIntensity) => set({ weatherIntensity }),
  toggleGarden: () => set((s) => ({ showGarden: !s.showGarden })),
  // Side-effecting because the AudioContext must be (de)activated in
  // the same call stack as the user gesture that triggered the toggle.
  toggleSound: () =>
    set((s) => {
      const next = !s.soundEnabled;
      if (next) ambientAudio.enable();
      else ambientAudio.disable();
      return { soundEnabled: next };
    }),
}));
