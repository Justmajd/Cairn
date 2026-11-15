/**
 * Two ways to hear the walk, crossfaded with the view:
 *
 * - Inside the helmet (visor view): what a suited astronaut hears is their own body and suit —
 *   breathing close to the ear in a small hard bubble, the ventilation fan, footfalls carried up
 *   through the boots, the heart when working hard, radio tones.
 * - Outside (3D and map views): what a microphone on the ground would hear.  Mars' air is ~1 % of
 *   Earth's and mostly CO₂: sound is faint and high pitches fade fastest (Perseverance's microphones,
 *   Maurice et al. 2022, Nature 605).  So: wind, and dull, quiet footsteps — no breathing.
 *
 * All of it is synthesised, no audio files.
 */
export class SuitAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** everything heard inside the helmet */
  private inside: GainNode | null = null;
  /** everything a microphone outside would hear */
  private outside: GainNode | null = null;
  private wind: GainNode | null = null;
  private windLp: BiquadFilterNode | null = null;
  private gustT = 0;
  private perspective: "inside" | "outside" | "far" = "outside";
  private noise: AudioBuffer | null = null;
  private breathGain: GainNode | null = null;
  private breathFilter: BiquadFilterNode | null = null;
  private breathPhase = 0;
  private beatPhase = 0;
  muted = false;

  /** Browsers only allow sound after a click or key press: call this from one. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);
    // one second of white noise, reused by every sound
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // the two listening places
    this.inside = ctx.createGain();
    this.outside = ctx.createGain();
    this.inside.gain.value = this.perspective === "inside" ? 1 : 0;
    this.outside.gain.value = this.perspective === "inside" ? 0 : this.perspective === "far" ? 0.5 : 1;
    // inside: a small hard bubble — a short comb (≈4 ms reflections) and a lift around 2 kHz
    const echo = ctx.createDelay(0.05);
    echo.delayTime.value = 0.0042;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const helmet = ctx.createBiquadFilter();
    helmet.type = "peaking";
    helmet.frequency.value = 2000;
    helmet.gain.value = 4;
    this.inside.connect(helmet).connect(this.master);
    this.inside.connect(echo).connect(fb).connect(echo);
    fb.connect(helmet);
    // outside: thin CO₂ air takes the high frequencies away
    const thin = ctx.createBiquadFilter();
    thin.type = "lowpass";
    thin.frequency.value = 900;
    this.outside.connect(thin).connect(this.master);

    // the suit fan: a steady low rush
    const fan = this.loop();
    const fanLp = ctx.createBiquadFilter();
    fanLp.type = "lowpass";
    fanLp.frequency.value = 260;
    const fanGain = ctx.createGain();
    fanGain.gain.value = 0.06;
    fan.connect(fanLp).connect(fanGain).connect(this.inside);
    // wind across the ground, in slow gusts (outside only)
    const wind = this.loop();
    this.windLp = ctx.createBiquadFilter();
    this.windLp.type = "lowpass";
    this.windLp.frequency.value = 320;
    this.windLp.Q.value = 0.7;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0.05;
    wind.connect(this.windLp).connect(this.wind).connect(this.outside);
    // breathing: band-passed noise, shaped breath by breath in update()
    const breath = this.loop();
    this.breathFilter = ctx.createBiquadFilter();
    this.breathFilter.type = "bandpass";
    this.breathFilter.frequency.value = 900;
    this.breathFilter.Q.value = 0.8;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    breath.connect(this.breathFilter).connect(this.breathGain).connect(this.inside);
  }

  /** Inside the helmet (visor), just outside (3D), or from above (map: the same, quieter). */
  setPerspective(p: "inside" | "outside" | "far"): void {
    this.perspective = p;
    const ctx = this.ctx;
    if (!ctx || !this.inside || !this.outside) return;
    this.inside.gain.setTargetAtTime(p === "inside" ? 1 : 0, ctx.currentTime, 0.25);
    this.outside.gain.setTargetAtTime(p === "inside" ? 0 : p === "far" ? 0.5 : 1, ctx.currentTime, 0.25);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  private loop(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start();
    return src;
  }

  /** Breathing and heartbeat follow the body's effort (`breaths` per minute, `bpm`). */
  update(dt: number, breaths: number, bpm: number, effort01: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.breathGain || !this.breathFilter) return;
    // gusts: a new strength and pitch every few seconds
    this.gustT -= dt;
    if (this.gustT <= 0 && this.wind && this.windLp) {
      this.gustT = 2 + Math.random() * 4;
      this.wind.gain.setTargetAtTime(0.025 + Math.random() * 0.07, ctx.currentTime, 1.2);
      this.windLp.frequency.setTargetAtTime(200 + Math.random() * 260, ctx.currentTime, 1.5);
    }
    this.breathPhase += (dt * breaths) / 60;
    const f = this.breathPhase % 1;
    // inhale (0–0.4), exhale (0.4–0.8, a little louder and lower), pause
    const env = f < 0.4 ? Math.sin((f / 0.4) * Math.PI) * 0.8 : f < 0.8 ? Math.sin(((f - 0.4) / 0.4) * Math.PI) : 0;
    const loud = 0.025 + effort01 * 0.09;
    this.breathGain.gain.setTargetAtTime(env * loud, ctx.currentTime, 0.03);
    this.breathFilter.frequency.setTargetAtTime(f < 0.4 ? 1100 : 750, ctx.currentTime, 0.05);
    // the heart becomes audible when working hard
    if (bpm > 105) {
      const before = this.beatPhase;
      this.beatPhase += (dt * bpm) / 60;
      if (Math.floor(this.beatPhase) !== Math.floor(before)) {
        const v = Math.min(0.35, (bpm - 105) / 160);
        this.thump(48, 0.09, v);
        window.setTimeout(() => this.thump(42, 0.08, v * 0.7), 140);
      }
    }
  }

  /**
   * A footfall.  Inside: a dull thud carried up through the suit, with a gritty crunch on firm ground.
   * Outside: only a faint, low scuff reaches a microphone through the thin air.
   */
  step(power: number, sand: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.inside || !this.outside) return;
    this.thump(70 + Math.random() * 15, 0.12, Math.min(0.6, 0.16 * power), this.inside);
    this.crunch(power, sand, this.inside, 1);
    this.crunch(power, sand, this.outside, 0.35);
    this.thump(55, 0.1, Math.min(0.12, 0.03 * power), this.outside);
  }

  private crunch(power: number, sand: number, bus: AudioNode, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.3;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1600 - sand * 1100;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, Math.min(0.25, 0.05 * power) * (1 - sand * 0.6) * vol), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09 + sand * 0.1);
    src.connect(bp).connect(g).connect(bus);
    src.start(t, Math.random() * 0.5, 0.25);
  }

  private thump(freq: number, dur: number, vol: number, bus: AudioNode | null = this.inside): void {
    const ctx = this.ctx;
    if (!ctx || vol <= 0) return;
    const o = ctx.createOscillator();
    o.type = "sine";
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(freq * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + dur * 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus ?? this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Radio tones before a message, like the Apollo-era "Quindar" beeps (2525 Hz). */
  beep(warn = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const tone = (f: number, at: number) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      const v = this.perspective === "inside" ? 0.06 : 0.03; // the radio is in the suit's headset
      g.gain.linearRampToValueAtTime(v, at + 0.01);
      g.gain.setValueAtTime(v, at + 0.2);
      g.gain.linearRampToValueAtTime(0, at + 0.23);
      o.connect(g).connect(this.master!);
      o.start(at);
      o.stop(at + 0.25);
    };
    const t = ctx.currentTime;
    tone(warn ? 1800 : 2525, t);
    if (warn) tone(1400, t + 0.28);
  }
}
