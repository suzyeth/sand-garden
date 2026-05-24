/**
 * Ambient audio: loads and loops a single Suno-generated track from
 * /audio/ambient.mp3. Web Audio because we want fade-in / fade-out
 * and speed-driven gain modulation that a raw <audio> tag can't do
 * cleanly.
 *
 * Browser autoplay policy requires a user gesture to start the
 * AudioContext, so the public `enable()` method must be called from
 * a click/keypress handler. After that the context stays alive; we
 * fade gain to 0 on `disable()` instead of tearing the graph down so
 * re-enabling is instant.
 *
 * If /audio/ambient.mp3 is missing or fails to decode the controller
 * stays in a benign disabled state — the rest of the app keeps
 * working, just silent.
 */

// Pool of Suno-generated ambient tracks. enable() picks one at random
// each time so reloading / re-toggling the audio gives variety. Add
// new files here as they're produced.
const AMBIENT_TRACKS = [
  '/audio/moss-circuit-1.mp3',
  '/audio/moss-circuit-2.mp3',
] as const;

// Master gain envelope.
const MASTER_BASE = 0.6;
// How much extra gain the bot's effective speed adds on top of base.
// Subtle on purpose — the Suno track has its own composition, we
// don't want the per-frame speed wobble pumping the volume audibly.
const MASTER_SPEED_SPAN = 0.18;
const FADE_IN_SEC = 1.8;
const FADE_OUT_SEC = 0.8;

// Day/night colouring of the audio. Tightened contrast versus the
// original tuning — night is now noticeably quieter and more muffled
// (cutoff drops to 800Hz, gain to 35%) so the transition reads
// without having to listen for it.
const TONE_HZ_DAY = 9500;
const TONE_HZ_NIGHT = 800;
const TIME_GAIN_DAY = 1.0;
const TIME_GAIN_NIGHT = 0.35;

// Wind layer — filtered white noise with a slow LFO on the filter
// cutoff. Sits below the Suno track at a low volume, adds an "outdoor"
// feel. Synthesised so no extra asset file needed.
const WIND_GAIN = 0.045;
const WIND_FILTER_BASE_HZ = 550;
const WIND_LFO_DEPTH_HZ = 240;
const WIND_LFO_RATE_HZ = 0.08; // ~12s per gust cycle

// Rain layer — same buffer approach as wind but band-passed in the
// "patter" range (2-4kHz) so it reads as actual rain on hard surfaces
// rather than a wind hiss. Gain is driven by setWeatherIntensity so
// the audio crossfades exactly with the visual rain ramp.
const RAIN_GAIN_PEAK = 0.18;
const RAIN_FILTER_HZ = 2800;
const RAIN_FILTER_Q = 0.7;

// Cricket layer — short tonal chirps gated on cycleT > 0.55 (matches
// fireflies). Synthesised as quick AM bursts on a sine oscillator so
// no asset is needed.
// 2900Hz reads as a real cricket (their resonant peak is ~2-5kHz)
// without the digital "beep" sharpness the original 4200Hz had on
// thinner speakers. A low-pass at ~5kHz on the master chain would
// catch any harmonic leakage; for now the sine carrier is clean
// enough that we don't need an explicit filter.
const CRICKET_BASE_HZ = 2900;
const CRICKET_CHIRP_INTERVAL_MIN = 4.5; // seconds between chirps
const CRICKET_CHIRP_INTERVAL_MAX = 11;
const CRICKET_PEAK_GAIN = 0.035;

// Frog croak — triggered while weather === 'rain', interval 12-20s.
// Low triangle wave at ~175Hz with quick exp decay; doubled pulse
// so each croak reads as the characteristic two-syllable "ribbit".
const FROG_BASE_HZ = 175;
const FROG_CROAK_INTERVAL_MIN = 12;
const FROG_CROAK_INTERVAL_MAX = 20;
const FROG_PEAK_GAIN = 0.07;

class AmbientAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private tone: BiquadFilterNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private windLfo: OscillatorNode | null = null;
  // Rain layer nodes — built lazily on first weather > 0 push.
  private rainSource: AudioBufferSourceNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  // Cricket scheduler — a scheduling loop ticks on cycleT updates and
  // queues a chirp burst when the next-chirp clock elapses.
  private cricketNext = 0; // ctx.currentTime of next chirp
  private cricketTimer: ReturnType<typeof setInterval> | null = null;
  // Frog scheduler — single shared timer with the cricket loop in
  // practice (driven by the same setInterval); croaks fire only
  // when isRaining is true.
  private frogNext = 0; // ctx.currentTime of next croak
  private isRaining = false;
  // Most recent night weight (0 day, 1 deep night) so the cricket
  // scheduler can scale chirp gain without an extra setter.
  private nightWeight = 0;
  // Multiplier on top of MASTER_BASE driven by time-of-day. Held as a
  // ref-like number so setSpeedNorm and setTimeOfDay can both push at
  // it without fighting an automation race.
  private timeGain = TIME_GAIN_DAY;
  private source: AudioBufferSourceNode | null = null;
  // Cache decoded buffers per URL so subsequent toggles are instant.
  private buffers = new Map<string, AudioBuffer>();
  // Per-URL in-flight load promise to dedupe concurrent fetches.
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  private enabled = false;

  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.tone = this.ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = TONE_HZ_DAY;
    this.tone.Q.value = 0.5;
    // Source -> tone -> master -> destination.
    this.tone.connect(this.master);
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  private async loadTrack(url: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    const cached = this.buffers.get(url);
    if (cached) return cached;
    const existing = this.loading.get(url);
    if (existing) return existing;
    const promise = (async (): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`[audio] ${url} not found (${res.status})`);
          return null;
        }
        const arr = await res.arrayBuffer();
        const buf = await this.ctx!.decodeAudioData(arr);
        this.buffers.set(url, buf);
        return buf;
      } catch (e) {
        console.warn(`[audio] load failed for ${url}`, e);
        return null;
      } finally {
        this.loading.delete(url);
      }
    })();
    this.loading.set(url, promise);
    return promise;
  }

  private pickTrack(): string {
    return AMBIENT_TRACKS[Math.floor(Math.random() * AMBIENT_TRACKS.length)];
  }

  /**
   * Build the synthesised wind layer once. Subsequent calls are
   * no-ops — once it's playing it just keeps going.
   */
  private startWindIfNeeded(): void {
    if (!this.ctx || !this.master || this.windSource) return;
    // 4 seconds of stereo-quality white noise, looped.
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, sr * 4, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const source = this.ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = WIND_FILTER_BASE_HZ;
    filter.Q.value = 0.9;

    const gain = this.ctx.createGain();
    gain.gain.value = WIND_GAIN;

    // LFO modulates the filter cutoff — sounds like slow wind gusts.
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = WIND_LFO_RATE_HZ;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = WIND_LFO_DEPTH_HZ;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);

    source.start();
    lfo.start();

    this.windSource = source;
    this.windFilter = filter;
    this.windGain = gain;
    this.windLfo = lfo;
  }

  /**
   * Synthesised rain — band-passed white noise. Same lazy-init pattern
   * as wind: build once, leave running, control via gain.
   */
  private startRainIfNeeded(): void {
    if (!this.ctx || !this.master || this.rainSource) return;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, sr * 4, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const source = this.ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = RAIN_FILTER_HZ;
    filter.Q.value = RAIN_FILTER_Q;

    const gain = this.ctx.createGain();
    gain.gain.value = 0; // ramp up via setWeatherIntensity

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);

    source.start();

    this.rainSource = source;
    this.rainFilter = filter;
    this.rainGain = gain;
  }

  /**
   * Cricket scheduler — fires brief AM bursts at random intervals
   * while the night weight is non-zero. Building the oscillator + env
   * graph per chirp is fine here: chirps are infrequent (~5-12s
   * apart) and the graph is small.
   */
  private startCricketSchedulerIfNeeded(): void {
    if (!this.ctx || !this.master || this.cricketTimer) return;
    // Initialise both schedulers relative to ctx clock so the first
    // chirp / croak fires within a reasonable window after enable().
    this.cricketNext = this.ctx.currentTime + 2.5;
    this.frogNext = this.ctx.currentTime + 6;
    this.cricketTimer = setInterval(() => {
      if (!this.ctx || !this.master || !this.enabled) return;
      const now = this.ctx.currentTime;
      // Crickets — only at night.
      if (this.nightWeight >= 0.05 && now >= this.cricketNext) {
        this.scheduleChirpBurst(now);
        this.cricketNext =
          now +
          CRICKET_CHIRP_INTERVAL_MIN +
          Math.random() *
            (CRICKET_CHIRP_INTERVAL_MAX - CRICKET_CHIRP_INTERVAL_MIN);
      }
      // Frog croaks — only while it's raining. Independent timing
      // so a single midnight rainstorm gets BOTH crickets + frogs.
      if (this.isRaining && now >= this.frogNext) {
        this.scheduleFrogCroak(now);
        this.frogNext =
          now +
          FROG_CROAK_INTERVAL_MIN +
          Math.random() *
            (FROG_CROAK_INTERVAL_MAX - FROG_CROAK_INTERVAL_MIN);
      }
    }, 250);
  }

  /**
   * Schedule a single chirp burst: 4-6 short pulses on a sine
   * oscillator with quick attack/decay, slightly detuned per chirp
   * so consecutive bursts don't feel identical.
   */
  private scheduleChirpBurst(start: number): void {
    if (!this.ctx || !this.master) return;
    const detune = (Math.random() - 0.5) * 220;
    const freq = CRICKET_BASE_HZ + detune;
    const peak = CRICKET_PEAK_GAIN * (0.6 + 0.4 * this.nightWeight);
    const pulseCount = 4 + Math.floor(Math.random() * 3); // 4-6
    const pulseDur = 0.028;
    const pulseGap = 0.07;
    for (let p = 0; p < pulseCount; p++) {
      const t = start + p * (pulseDur + pulseGap);
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq + (p % 2 === 0 ? 0 : 60);
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.005);
      env.gain.exponentialRampToValueAtTime(0.0001, t + pulseDur);
      osc.connect(env);
      env.connect(this.master);
      osc.start(t);
      osc.stop(t + pulseDur + 0.01);
    }
  }

  /**
   * Schedule a single frog croak — two short pulses on a triangle
   * carrier at ~175Hz, second pulse slightly higher. Each pulse has
   * an exp decay envelope so the croak reads as a chesty "ribbit"
   * rather than a digital beep.
   */
  private scheduleFrogCroak(start: number): void {
    if (!this.ctx || !this.master) return;
    const pulseCount = 2;
    const pulseDur = 0.16;
    const pulseGap = 0.08;
    for (let p = 0; p < pulseCount; p++) {
      const t = start + p * (pulseDur + pulseGap);
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      // Second syllable a touch higher — characteristic of real
      // frog croaks (and reads less monotonous than two identical
      // pulses).
      osc.frequency.value = FROG_BASE_HZ * (p === 0 ? 1 : 1.18);
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(FROG_PEAK_GAIN, t + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0005, t + pulseDur);
      osc.connect(env);
      env.connect(this.master);
      osc.start(t);
      osc.stop(t + pulseDur + 0.02);
    }
  }

  /**
   * Toggle the frog croak scheduler from the Weather component. The
   * scheduler ticks regardless, but only fires while this flag is
   * true so croaks are gated to rainy periods only.
   */
  setIsRaining(r: boolean): void {
    this.isRaining = r;
  }

  /**
   * Drive the rain layer gain from the smoothed weather intensity.
   * Lazy-initialised so we don't build the synth nodes until the
   * first time the player actually hears rain.
   */
  setWeatherIntensity(i: number): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    this.startRainIfNeeded();
    if (!this.rainGain) return;
    const clamped = Math.max(0, Math.min(1, i));
    // Square the intensity so drizzle is quietly audible and heavy
    // dominates; matches the way the visuals scale.
    const target = RAIN_GAIN_PEAK * clamped * clamped;
    this.rainGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.6);
  }

  /**
   * Start playback. MUST be invoked from a user-gesture handler the
   * very first time, otherwise the AudioContext stays suspended.
   */
  async enable(): Promise<void> {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* user gesture missing — toggling again from a button will fix it */
      }
    }
    const url = this.pickTrack();
    const buffer = await this.loadTrack(url);
    if (!buffer) return;
    this.enabled = true;

    // Build a fresh source each time we enable so a disable→enable
    // cycle restarts cleanly without a stutter from a paused buffer.
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
    }
    this.source = ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = true;
    // Loop the middle 80% of the buffer — Suno tracks typically have
    // a fade-in/out so we skip those edges. Loop bounds are based on
    // the buffer's own duration so it stays musical even when the
    // track is short.
    const padding = Math.min(15, buffer.duration * 0.1);
    this.source.loopStart = padding;
    this.source.loopEnd = buffer.duration - padding;
    // Route through the tone filter (day/night low-pass).
    this.source.connect(this.tone ?? this.master);
    // Start playback already past the lead-in.
    this.source.start(0, padding);

    // Wind layer — lazy build once, then stays alive.
    this.startWindIfNeeded();
    // Cricket scheduler — starts ticking; chirps only fire while
    // nightWeight is non-trivial, so daytime enables are silent.
    this.startCricketSchedulerIfNeeded();

    // Snap gain directly. We avoid a gain ramp here because the Suno
    // tracks already fade themselves in via the skipped intro, and
    // setSpeedNorm's setTargetAtTime calls would otherwise interleave
    // with the ramp's setTargetAtTime in subtly broken ways.
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setValueAtTime(MASTER_BASE * this.timeGain, ctx.currentTime);
  }

  disable(): void {
    this.enabled = false;
    if (!this.ctx || !this.master) return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(
      this.master.gain.value,
      this.ctx.currentTime,
    );
    this.master.gain.setTargetAtTime(
      0,
      this.ctx.currentTime,
      FADE_OUT_SEC / 3,
    );
    // Mute the rain layer too — the master fade muffles it, but
    // ducking rainGain explicitly means it doesn't pop back at full
    // volume on the next enable() if intensity is still high.
    if (this.rainGain) {
      this.rainGain.gain.setTargetAtTime(
        0,
        this.ctx.currentTime,
        FADE_OUT_SEC / 3,
      );
    }
  }

  /**
   * Subtle ducking of the master gain by robot speed. `s` is roughly
   * 0..1.4 (1 = rake pace, 1.4 = full transit). Capped so the speed
   * wobble can't pump audibly.
   */
  setSpeedNorm(s: number): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const norm = Math.max(0, Math.min(1.4, s)) / 1.4;
    const target = (MASTER_BASE + norm * MASTER_SPEED_SPAN) * this.timeGain;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.3);
  }

  /**
   * Drive day/night colouring of the music from a normalised cycle
   * position `t` in [0, 1):
   *   0.00 dawn, 0.25 noon, 0.50 dusk, 0.75 night, wraps at 1.0.
   *
   * Computes a "daylight" weight on the same curve as SceneLighting's
   * keyframes — peaks at noon, troughs at night — then crossfades the
   * low-pass cutoff and gain between TONE_HZ_DAY/NIGHT and
   * TIME_GAIN_DAY/NIGHT. Smoothing is left to setTargetAtTime so the
   * tone slide doesn't click.
   */
  setTimeOfDay(t: number): void {
    if (!this.enabled || !this.ctx || !this.tone || !this.master) return;
    // 4-keyframe daylight weights matching SceneLighting:
    // dawn 0.45, noon 1.0, dusk 0.45, night 0.05. Smooth-stepped
    // between adjacent keyframes by the same fractional phase index.
    const KFS = [0.45, 1.0, 0.45, 0.05];
    const phaseF = (((t % 1) + 1) % 1) * KFS.length;
    const idx = Math.floor(phaseF) % KFS.length;
    const next = (idx + 1) % KFS.length;
    const uRaw = phaseF - Math.floor(phaseF);
    const u = uRaw * uRaw * (3 - 2 * uRaw); // smoothstep
    const daylight = KFS[idx] + (KFS[next] - KFS[idx]) * u;

    const hz = TONE_HZ_NIGHT + (TONE_HZ_DAY - TONE_HZ_NIGHT) * daylight;
    const gainMul =
      TIME_GAIN_NIGHT + (TIME_GAIN_DAY - TIME_GAIN_NIGHT) * daylight;
    this.timeGain = gainMul;
    // 0 in full daylight, 1 in deep night — used by the cricket
    // scheduler to gate + scale chirp gain. Same shape as the
    // dragonfly gate but inverted.
    this.nightWeight = 1 - daylight;
    this.tone.frequency.setTargetAtTime(hz, this.ctx.currentTime, 1.2);
    // The actual master.gain update is handled by setSpeedNorm in
    // the next animation tick — it multiplies by this.timeGain so the
    // value flows through naturally.
  }
}

export const ambientAudio = new AmbientAudio();
