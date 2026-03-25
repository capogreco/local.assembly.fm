/**
 * Stochastic Event Swarm Worklet — resonant event swarm synthesis
 * Parameters via AudioParam: rate, freqMin, freqMax, chirp, decay,
 * amplitude, transientMix, resonatorQ, density.
 * Physically-motivated: log-uniform frequency, constant-Q decay,
 * amplitude-frequency correlation, temporal clustering, sibling spawning.
 */

class SwarmProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rate",         defaultValue: 20,   automationRate: "k-rate" },
      { name: "freqMin",      defaultValue: 500,  automationRate: "k-rate" },
      { name: "freqMax",      defaultValue: 3000, automationRate: "k-rate" },
      { name: "chirp",        defaultValue: 0,    automationRate: "k-rate" },
      { name: "decay",        defaultValue: 0.5,  automationRate: "k-rate" },
      { name: "amplitude",    defaultValue: 0,    automationRate: "k-rate" },
      { name: "transientMix", defaultValue: 0,    automationRate: "k-rate" },
      { name: "resonatorQ",   defaultValue: 0,    automationRate: "k-rate" },
      { name: "density",      defaultValue: 1,    automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.sr = sampleRate;
    const N = 192;
    this.N = N;

    this.phase      = new Float32Array(N);
    this.freq       = new Float32Array(N);
    this.evChirp    = new Float32Array(N);
    this.chirpDecay = new Float32Array(N);
    this.amp        = new Float32Array(N);
    this.decayMul   = new Float32Array(N);
    this.transLeft  = new Int32Array(N);
    this.transLen   = new Int32Array(N);
    this.transLP    = new Float32Array(N);
    this.active     = new Uint8Array(N);

    this.useRes = new Uint8Array(N);
    this.z1     = new Float32Array(N);
    this.z2     = new Float32Array(N);
    this.b0     = new Float32Array(N);
    this.b1     = new Float32Array(N);
    this.b2     = new Float32Array(N);
    this.a1     = new Float32Array(N);
    this.a2     = new Float32Array(N);

    this.nextEvent = 0;
    this.rateMod = 0;
    this.globalLP = 0;
    this.dcX = 0;
    this.dcY = 0;

    // Cached params (read from AudioParams once per block)
    this.c = {};
  }

  spawnEventAt(f, a, dm, chirpVal, chirpDk, hasTransient) {
    let slot = -1;
    for (let i = 0; i < this.N; i++) {
      if (!this.active[i]) { slot = i; break; }
    }
    if (slot < 0) return;

    this.active[slot] = 1;
    this.phase[slot] = Math.random() * 6.2832;
    this.freq[slot] = f;
    this.evChirp[slot] = chirpVal;
    this.chirpDecay[slot] = chirpDk;
    this.amp[slot] = a;
    this.decayMul[slot] = dm;

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

    const resQ = this.c.resonatorQ || 0;
    if (resQ > 0) {
      this.useRes[slot] = 1;
      const w0 = 6.2832 * f / this.sr;
      const alpha = Math.sin(w0) / (2 * resQ);
      const a0 = 1 + alpha;
      this.b0[slot] = alpha / a0;
      this.b1[slot] = 1; // impulse pending
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
    const c = this.c;
    const logMin = Math.log(c.freqMin || 20);
    const logMax = Math.log(c.freqMax || 20000);
    const f = Math.exp(logMin + Math.random() * (logMax - logMin));

    const fRef = Math.exp((logMin + logMax) * 0.5);
    const ampScale = Math.min(fRef / f, 4.0);
    const a = Math.random() * c.amplitude * ampScale;

    const Q = 5 + c.decay * 25;
    const t60 = Q / f;
    const dm = Math.exp(-6.9 / (t60 * this.sr));

    let chirpVal, chirpDk;
    if (c.chirp > 0) {
      chirpVal = c.chirp / this.sr;
      chirpDk = 1;
    } else if (c.chirp < 0) {
      chirpVal = c.chirp / this.sr;
      chirpDk = Math.exp(-10 / (0.003 * this.sr));
    } else {
      chirpVal = -f * 0.1 / this.sr;
      chirpDk = Math.exp(-10 / (0.003 * this.sr));
    }

    const hasTransient = Math.random() < c.transientMix;
    this.spawnEventAt(f, a, dm, chirpVal, chirpDk, hasTransient);

    if (Math.random() < 0.3) {
      const numSiblings = 1 + Math.floor(Math.random() * 3);
      for (let s = 0; s < numSiblings; s++) {
        const sibF = f * (0.7 + Math.random() * 0.5);
        const sibAmpScale = Math.min(fRef / sibF, 4.0);
        const sibA = Math.random() * c.amplitude * sibAmpScale * 0.5;
        const sibT60 = Q / sibF;
        const sibDm = Math.exp(-6.9 / (sibT60 * this.sr));
        this.spawnEventAt(sibF, sibA, sibDm, chirpVal * 0.7, chirpDk, false);
      }
    }
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const blockSize = out.length;

    // Cache AudioParam values for this block
    const c = this.c;
    c.rate         = parameters.rate[0];
    c.freqMin      = parameters.freqMin[0];
    c.freqMax      = parameters.freqMax[0];
    c.chirp        = parameters.chirp[0];
    c.decay        = parameters.decay[0];
    c.amplitude    = parameters.amplitude[0];
    c.transientMix = parameters.transientMix[0];
    c.resonatorQ   = parameters.resonatorQ[0];
    c.density      = parameters.density[0];

    // Don't spawn if amplitude is zero (no params set yet)
    if (c.amplitude > 0) {
      this.rateMod += (Math.random() - 0.5) * 0.1;
      this.rateMod *= 0.995;
      const effectiveRate = Math.max(0.01, c.rate * Math.exp(this.rateMod));

      const blockDuration = blockSize / this.sr;
      this.nextEvent -= blockDuration;
      while (this.nextEvent <= 0) {
        this.spawnEvent();
        this.nextEvent += -Math.log(Math.max(1e-10, 1 - Math.random())) / effectiveRate;
      }
    }

    const twoPiOverSr = 6.2832 / this.sr;
    const density = c.density;
    const transientLP = 0.5;

    for (let s = 0; s < blockSize; s++) {
      let sum = 0;

      for (let i = 0; i < this.N; i++) {
        if (!this.active[i]) continue;
        let sample = 0;

        if (this.transLeft[i] > 0) {
          const t = 1 - this.transLeft[i] / this.transLen[i];
          const noiseEnv = Math.exp(-5 * t);
          const toneEnv = t;
          const noise = Math.random() * 2 - 1;
          this.transLP[i] = this.transLP[i] * (1 - transientLP) + noise * transientLP;
          const sinSample = Math.sin(this.phase[i]);
          sample = this.amp[i] * (this.transLP[i] * noiseEnv + sinSample * toneEnv);
          this.phase[i] += this.freq[i] * twoPiOverSr;
          this.freq[i] += this.evChirp[i];
          this.evChirp[i] *= this.chirpDecay[i];
          this.transLeft[i]--;
        } else if (this.useRes[i]) {
          const impulse = this.b1[i] > 0 ? 1.0 : 0;
          if (impulse) this.b1[i] = 0;
          const y = this.b0[i] * impulse - this.a1[i] * this.z1[i] - this.a2[i] * this.z2[i];
          this.z2[i] = this.z1[i];
          this.z1[i] = y;
          sample = y * this.amp[i];
        } else {
          sample = this.amp[i] * Math.sin(this.phase[i]);
          this.phase[i] += this.freq[i] * twoPiOverSr;
          this.freq[i] += this.evChirp[i];
          this.evChirp[i] *= this.chirpDecay[i];
          if (this.phase[i] > 6.2832) this.phase[i] -= 6.2832;
        }

        this.amp[i] *= this.decayMul[i];
        if (this.amp[i] < 0.0001) { this.active[i] = 0; continue; }
        sum += sample;
      }

      this.globalLP = this.globalLP * 0.15 + sum * 0.85;
      const shaped = this.globalLP * density;
      this.dcY = shaped - this.dcX + 0.995 * this.dcY;
      this.dcX = shaped;
      out[s] = this.dcY;
    }
    return true;
  }
}

registerProcessor("swarm-processor", SwarmProcessor);
