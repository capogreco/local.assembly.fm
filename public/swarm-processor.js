/**
 * Stochastic Event Swarm Worklet — resonant event swarm synthesis
 *
 * Parameters controlled via message port with portamento smoothing.
 * Pool of 128 pre-allocated events: damped sinusoids, chirps,
 * noise transients, biquad resonators. Poisson trigger at control rate.
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
    const N = 128;
    this.N = N;

    // Parallel typed arrays — cache-friendly event pool
    this.phase     = new Float32Array(N);
    this.freq      = new Float32Array(N);
    this.evChirp   = new Float32Array(N);
    this.amp       = new Float32Array(N);
    this.decayMul  = new Float32Array(N);
    this.transLeft = new Int32Array(N);
    this.active    = new Uint8Array(N);

    // Biquad resonator state
    this.useRes = new Uint8Array(N);
    this.z1     = new Float32Array(N);
    this.z2     = new Float32Array(N);
    this.b0     = new Float32Array(N);
    this.b1     = new Float32Array(N);
    this.b2     = new Float32Array(N);
    this.a1     = new Float32Array(N);
    this.a2     = new Float32Array(N);

    // Poisson accumulator
    this.poissonAccum = 0;

    // Portamento targets and current values
    this.targets = {
      rate: 20, freqMin: 500, freqMax: 3000, chirp: 0,
      decay: 0.5, amplitude: 0.5, transientMix: 0,
      resonatorQ: 0, density: 1,
    };
    this.current = { ...this.targets };

    // Portamento alpha: 1 = instant (no smoothing)
    this.portamentoAlpha = 1;

    // Params driven by audio-rate connections (skip portamento for these)
    this.audioConnectedParams = new Set();

    // Message port for parameter updates
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "params") {
        for (const key of Object.keys(this.targets)) {
          if (msg[key] !== undefined) {
            this.targets[key] = msg[key];
          }
        }
      } else if (msg.type === "audioConnected") {
        this.audioConnectedParams = new Set(msg.params);
      }
    };
  }

  spawnEvent() {
    // Find first inactive slot
    let slot = -1;
    for (let i = 0; i < this.N; i++) {
      if (!this.active[i]) { slot = i; break; }
    }
    if (slot < 0) return;

    const c = this.current;
    const f = c.freqMin + Math.random() * (c.freqMax - c.freqMin);
    const a = (0.5 + Math.random() * 0.5) * c.amplitude;
    const dm = 0.99 + c.decay * 0.00995;

    this.active[slot] = 1;
    this.phase[slot] = 0;
    this.freq[slot] = f;
    this.evChirp[slot] = c.chirp / this.sr;
    this.amp[slot] = a;
    this.decayMul[slot] = dm;

    // Noise transient
    this.transLeft[slot] = Math.random() < c.transientMix
      ? Math.round(0.002 * this.sr) : 0;

    // Biquad resonator mode
    if (c.resonatorQ > 0) {
      this.useRes[slot] = 1;
      const w0 = 2 * Math.PI * f / this.sr;
      const alpha = Math.sin(w0) / (2 * c.resonatorQ);
      const a0 = 1 + alpha;
      this.b0[slot] = (Math.sin(w0) / 2) / a0;
      this.b1[slot] = 0;
      this.b2[slot] = -(Math.sin(w0) / 2) / a0;
      this.a1[slot] = (-2 * Math.cos(w0)) / a0;
      this.a2[slot] = (1 - alpha) / a0;
      this.z1[slot] = 1.0; // pre-seed to start ringing
      this.z2[slot] = 0;
    } else {
      this.useRes[slot] = 0;
      this.z1[slot] = 0;
      this.z2[slot] = 0;
    }
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const out = output[0];
    const blockSize = out.length;
    const alpha = this.portamentoAlpha;

    // Read audio-connected params from AudioParam inputs (overrides portamento)
    for (const name of this.audioConnectedParams) {
      const p = parameters[name];
      if (p && p.length > 0) {
        this.current[name] = p[0];
        this.targets[name] = p[0];
      }
    }

    // Portamento smoothing (once per block for non-audio-connected params)
    for (const key of Object.keys(this.targets)) {
      if (!this.audioConnectedParams.has(key)) {
        this.current[key] += alpha * (this.targets[key] - this.current[key]);
      }
    }

    // Poisson trigger (control rate)
    const blockDuration = blockSize / this.sr;
    this.poissonAccum += this.current.rate * blockDuration;
    while (this.poissonAccum >= 1) {
      this.spawnEvent();
      this.poissonAccum -= 1;
    }

    const twoPiOverSr = 2 * Math.PI / this.sr;
    const density = this.current.density;

    // Per-sample loop
    for (let s = 0; s < blockSize; s++) {
      let sum = 0;

      for (let i = 0; i < this.N; i++) {
        if (!this.active[i]) continue;

        let sample = 0;

        if (this.transLeft[i] > 0) {
          // Noise burst transient
          sample = this.amp[i] * (Math.random() * 2 - 1);
          this.transLeft[i]--;
        } else if (this.useRes[i]) {
          // Biquad resonator (feed 0 input, read ringing output)
          const y = this.b0[i] * 0 - this.a1[i] * this.z1[i] - this.a2[i] * this.z2[i];
          this.z2[i] = this.z1[i];
          this.z1[i] = y;
          sample = y * this.amp[i];
        } else {
          // Damped sinusoid
          sample = this.amp[i] * Math.sin(this.phase[i]);
          this.phase[i] += this.freq[i] * twoPiOverSr;
          this.freq[i] += this.evChirp[i];
        }

        // Per-sample decay
        this.amp[i] *= this.decayMul[i];

        // Deactivate when quiet
        if (this.amp[i] < 0.0001) {
          this.active[i] = 0;
          continue;
        }

        sum += sample;
      }

      out[s] = sum * density;
    }

    return true;
  }
}

registerProcessor("swarm-processor", SwarmProcessor);
