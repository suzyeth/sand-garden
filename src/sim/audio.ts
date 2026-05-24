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

class AmbientAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private tone: BiquadFilterNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private windLfo: OscillatorNode | null = null;
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
    this.tone.frequency.setTargetAtTime(hz, this.ctx.currentTime, 1.2);
    // The actual master.gain update is handled by setSpeedNorm in
    // the next animation tick — it multiplies by this.timeGain so the
    // value flows through naturally.
  }
}

export const ambientAudio = new AmbientAudio();
