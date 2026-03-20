/**
 * Stochastic Event Swarm Worklet — resonant event swarm synthesis
 *
 * Pool of pre-allocated events: damped sinusoids with chirp,
 * shaped noise transients, biquad resonators. True Poisson trigger
 * with temporal clustering. Physically-motivated frequency distribution,
 * amplitude-frequency correlation, and constant-Q decay.
 * Single mono output channel.
 */

class SwarmProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rate",         defaultValue: 20,   automationRate: "k-rate" },
      { name: "freqMin",      defaultValue: 500,  automationRate: "k-rate" },
      { name: "freqMax",      defaultValue: 3000, automationRate: "k-rate" },
      { name: "chirp",        defaultValue: 0,    automationRate: "k-rate" },
      { name: "decay",        defaultValue: 0.5,  automationRate: "k-rate" },
      { name: "amplitude",    defaultValue: 0.5,  automationRate: "k-rate" },
      { name: "transientMix", defaultValue: 0,    automationRate: "k-rate" },
      { name: "resonatorQ",   defaultValue: 0,    automationRate: "k-rate" },
      { name: "density",      defaultValue: 1,    automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();

    this.sr = sampleRate;
    const N = 192; // increased from 128 for sibling spawning
    this.N = N;

    // Parallel typed arrays — cache-friendly event pool
    this.phase      = new Float32Array(N);
    this.freq       = new Float32Array(N);
    this.evChirp    = new Float32Array(N);
    this.chirpDecay = new Float32Array(N); // chirp fades over time
    this.amp        = new Float32Array(N);
    this.decayMul   = new Float32Array(N);
    this.transLeft  = new Int32Array(N);
    this.transLen   = new Int32Array(N);
    this.transLP    = new Float32Array(N); // one-pole LP state for transient noise
    this.active     = new Uint8Array(N);

    // Biquad resonator state
    this.useRes = new Uint8Array(N);
    this.z1     = new Float32Array(N);
    this.z2     = new Float32Array(N);
    this.b0     = new Float32Array(N);
    this.b1     = new Float32Array(N); // repurposed as impulse-pending flag
    this.b2     = new Float32Array(N);
    this.a1     = new Float32Array(N);
    this.a2     = new Float32Array(N);

    // Poisson: next event time
    this.nextEvent = 0;

    // Rate modulation for temporal clustering (slow random walk)
    this.rateMod = 0;

    // Global output filter state (air absorption)
    this.globalLP = 0;

    // DC blocker state
    this.dcX = 0;
    this.dcY = 0;

    // Don't spawn until first params message arrives
    this.ready = false;

    // Params
    this.targets = {
      rate: 20, freqMin: 500, freqMax: 3000, chirp: 0,
      decay: 0.5, amplitude: 0.5, transientMix: 0,
      resonatorQ: 0, density: 1,
    };
    this.current = { ...this.targets };
    this.portamentoAlpha = 1;
    this.audioConnectedParams = new Set();

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "params") {
        if (!this.ready) this.port.postMessage({ type: "debug", msg: "first params received", params: msg });
        this.ready = true;
        for (const key of Object.keys(this.targets)) {
          if (msg[key] !== undefined) this.targets[key] = msg[key];
        }
      } else if (msg.type === "audioConnected") {
        this.audioConnectedParams = new Set(msg.params);
      }
    };
  }

  spawnEventAt(f, a, dm, chirpVal, chirpDk, hasTransient) {
    let slot = -1;
    for (let i = 0; i < this.N; i++) {
      if (!this.active[i]) { slot = i; break; }
    }
    if (slot < 0) return;

    const c = this.current;

    this.active[slot] = 1;
    this.phase[slot] = Math.random() * 6.2832;
    this.freq[slot] = f;
    this.evChirp[slot] = chirpVal;
    this.chirpDecay[slot] = chirpDk;
    this.amp[slot] = a;
    this.decayMul[slot] = dm;

    // Noise transient
    if (hasTransient) {
      const len = Math.round((0.001 + Math.random() * 0.004) * this.sr);
      this.transLeft[slot] = len;
      this.transLen[slot] = len;
      this.transLP[slot] = 0;
    } else {
      this.transLeft[slot] = 0;
      this.transLen[slot] = 0;
      this.transLP[slot] = 0;
    }

    // Biquad resonator mode
    if (c.resonatorQ > 0) {
      this.useRes[slot] = 1;
      const w0 = 6.2832 * f / this.sr;
      const alpha = Math.sin(w0) / (2 * c.resonatorQ);
      const a0 = 1 + alpha;
      this.b0[slot] = alpha / a0;
      this.b1[slot] = 1; // impulse pending flag
      this.b2[slot] = -alpha / a0;
      this.a1[slot] = (-2 * Math.cos(w0)) / a0;
      this.a2[slot] = (1 - alpha) / a0;
      this.z1[slot] = 0;
      this.z2[slot] = 0;
    } else {
      this.useRes[slot] = 0;
    }
  }

  spawnEvent() {
    const c = this.current;

    // Rec 1: Log-uniform frequency distribution (equal probability per octave)
    const logMin = Math.log(c.freqMin || 20);
    const logMax = Math.log(c.freqMax || 20000);
    const f = Math.exp(logMin + Math.random() * (logMax - logMin));

    // Rec 2: Amplitude-frequency correlation (bigger bubble = lower freq = louder)
    const fRef = Math.exp((logMin + logMax) * 0.5); // geometric mean
    const ampScale = Math.min(fRef / f, 4.0); // 1/f scaling, clamped
    const a = Math.random() * c.amplitude * ampScale;

    // Rec 3: Constant-Q decay (T60 proportional to 1/freq)
    const Q = 5 + c.decay * 25; // decay param maps to Q: 5-30 cycles
    const t60 = Q / f;
    const dm = Math.exp(-6.9 / (t60 * this.sr));

    // Rec 4: Chirp with decay
    let chirpVal, chirpDk;
    if (c.chirp > 0) {
      // Positive chirp param: upward sweep (fizz/Helmholtz)
      chirpVal = c.chirp / this.sr;
      chirpDk = 1; // constant chirp for fizz
    } else if (c.chirp < 0) {
      // Negative chirp param: downward sweep (creek bubble settling)
      chirpVal = c.chirp / this.sr;
      chirpDk = Math.exp(-10 / (0.003 * this.sr)); // chirp fades in ~3ms
    } else {
      // Auto-chirp: slight downward for creek character
      chirpVal = -f * 0.1 / this.sr; // 10% downward
      chirpDk = Math.exp(-10 / (0.003 * this.sr));
    }

    const hasTransient = Math.random() < c.transientMix;

    // Spawn primary event
    this.spawnEventAt(f, a, dm, chirpVal, chirpDk, hasTransient);

    // Rec 7: Sibling bubble spawning (30% chance, 1-3 siblings)
    if (Math.random() < 0.3) {
      const numSiblings = 1 + Math.floor(Math.random() * 3);
      for (let s = 0; s < numSiblings; s++) {
        const sibF = f * (0.7 + Math.random() * 0.5); // within ±30%, biased lower
        const sibAmpScale = Math.min(fRef / sibF, 4.0);
        const sibA = Math.random() * c.amplitude * sibAmpScale * 0.5; // quieter
        const sibT60 = Q / sibF;
        const sibDm = Math.exp(-6.9 / (sibT60 * this.sr));
        this.spawnEventAt(sibF, sibA, sibDm, chirpVal * 0.7, chirpDk, false);
      }
    }
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const out = output[0];
    const blockSize = out.length;
    const alpha = this.portamentoAlpha;

    // Read audio-connected params
    for (const name of this.audioConnectedParams) {
      const p = parameters[name];
      if (p?.length > 0) { this.current[name] = p[0]; this.targets[name] = p[0]; }
    }

    // Portamento smoothing (once per block)
    for (const key of Object.keys(this.targets)) {
      if (!this.audioConnectedParams.has(key)) {
        this.current[key] += alpha * (this.targets[key] - this.current[key]);
      }
    }

    // Rec 6: Temporal clustering — modulate rate with slow random walk
    this.rateMod += (Math.random() - 0.5) * 0.1;
    this.rateMod *= 0.995; // mean-reverting
    const effectiveRate = Math.max(0.01, this.current.rate * Math.exp(this.rateMod));

    // Stochastic Poisson trigger with clustering (wait for first params)
    if (this.ready) {
      const blockDuration = blockSize / this.sr;
      this.nextEvent -= blockDuration;
      while (this.nextEvent <= 0) {
        this.spawnEvent();
        this.nextEvent += -Math.log(Math.max(1e-10, 1 - Math.random())) / effectiveRate;
      }
    }

    const twoPiOverSr = 6.2832 / this.sr;
    const density = this.current.density;

    // Rec 5: Transient LP coefficient (0.3 = dull water surface, 0.9 = bright hard surface)
    const transientLP = 0.5;

    for (let s = 0; s < blockSize; s++) {
      let sum = 0;

      for (let i = 0; i < this.N; i++) {
        if (!this.active[i]) continue;

        let sample = 0;

        if (this.transLeft[i] > 0) {
          // Rec 5 + 6 + 9: Shaped, filtered noise transient overlapping with sinusoid onset
          const t = 1 - this.transLeft[i] / this.transLen[i]; // 0→1 progress
          const noiseEnv = Math.exp(-5 * t); // exponential decay on noise
          const toneEnv = t; // tone fades in linearly

          // Filtered noise (one-pole LP)
          const noise = Math.random() * 2 - 1;
          this.transLP[i] = this.transLP[i] * (1 - transientLP) + noise * transientLP;

          // Cross-fade: noise out, sinusoid in
          const sinSample = Math.sin(this.phase[i]);
          sample = this.amp[i] * (this.transLP[i] * noiseEnv + sinSample * toneEnv);

          this.phase[i] += this.freq[i] * twoPiOverSr;
          this.freq[i] += this.evChirp[i];
          this.evChirp[i] *= this.chirpDecay[i];
          this.transLeft[i]--;
        } else if (this.useRes[i]) {
          // Biquad resonator
          const impulse = this.b1[i] > 0 ? 1.0 : 0;
          if (impulse) this.b1[i] = 0;
          const y = this.b0[i] * impulse - this.a1[i] * this.z1[i] - this.a2[i] * this.z2[i];
          this.z2[i] = this.z1[i];
          this.z1[i] = y;
          sample = y * this.amp[i];
        } else {
          // Damped sinusoid with decaying chirp
          sample = this.amp[i] * Math.sin(this.phase[i]);
          this.phase[i] += this.freq[i] * twoPiOverSr;
          this.freq[i] += this.evChirp[i];
          this.evChirp[i] *= this.chirpDecay[i];
          if (this.phase[i] > 6.2832) this.phase[i] -= 6.2832;
        }

        // Per-sample amplitude decay
        this.amp[i] *= this.decayMul[i];

        if (this.amp[i] < 0.0001) {
          this.active[i] = 0;
          continue;
        }

        sum += sample;
      }

      // Rec 8: Global spectral shaping (gentle air absorption LP)
      this.globalLP = this.globalLP * 0.15 + sum * 0.85;
      const shaped = this.globalLP * density;

      // DC blocker
      this.dcY = shaped - this.dcX + 0.995 * this.dcY;
      this.dcX = shaped;
      out[s] = this.dcY;
    }

    return true;
  }
}

registerProcessor("swarm-processor", SwarmProcessor);
