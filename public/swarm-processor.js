/**
 * Stochastic Event Swarm Worklet — resonant event swarm synthesis
 *
 * Pool of 128 pre-allocated events: damped sinusoids with chirp,
 * shaped noise transients, biquad resonators. Stochastic Poisson trigger.
 * Parameter regimes yield creek, fizz, rain, and everything between.
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
    this.transLen  = new Int32Array(N);  // original transient length (for envelope)
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

    // Poisson: next event time (in seconds from now)
    this.nextEvent = 0;

    // Portamento targets and current values
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
        for (const key of Object.keys(this.targets)) {
          if (msg[key] !== undefined) this.targets[key] = msg[key];
        }
      } else if (msg.type === "audioConnected") {
        this.audioConnectedParams = new Set(msg.params);
      }
    };
  }

  spawnEvent() {
    let slot = -1;
    for (let i = 0; i < this.N; i++) {
      if (!this.active[i]) { slot = i; break; }
    }
    if (slot < 0) return;

    const c = this.current;
    const f = c.freqMin + Math.random() * (c.freqMax - c.freqMin);

    // Wide amplitude randomization (0-100% of amplitude param)
    const a = Math.random() * c.amplitude;

    // Decay: map 0-1 to T60 time, then to per-sample multiplier
    // decay=0 → 1ms (fizz), decay=1 → 500ms (long ring)
    const t60 = 0.001 + c.decay * 0.499;
    const dm = Math.exp(-6.9 / (t60 * this.sr));

    this.active[slot] = 1;
    this.phase[slot] = Math.random() * 2 * Math.PI; // random initial phase
    this.freq[slot] = f;
    // Chirp: parameter is in Hz/s, convert to Hz/sample
    this.evChirp[slot] = c.chirp / this.sr;
    this.amp[slot] = a;
    this.decayMul[slot] = dm;

    // Noise transient (shaped envelope, not flat)
    if (Math.random() < c.transientMix) {
      const len = Math.round((0.001 + Math.random() * 0.004) * this.sr); // 1-5ms
      this.transLeft[slot] = len;
      this.transLen[slot] = len;
    } else {
      this.transLeft[slot] = 0;
      this.transLen[slot] = 0;
    }

    // Biquad resonator mode
    if (c.resonatorQ > 0) {
      this.useRes[slot] = 1;
      const w0 = 2 * Math.PI * f / this.sr;
      const alpha = Math.sin(w0) / (2 * c.resonatorQ);
      const a0 = 1 + alpha;
      this.b0[slot] = alpha / a0;
      this.b1[slot] = 0;
      this.b2[slot] = -alpha / a0;
      this.a1[slot] = (-2 * Math.cos(w0)) / a0;
      this.a2[slot] = (1 - alpha) / a0;
      // Impulse excitation: feed a 1.0 as the first input sample
      // We'll track this with z1/z2 = 0 and handle first sample in process
      this.z1[slot] = 0;
      this.z2[slot] = 0;
      // Store flag to inject impulse on first non-transient sample
      this.b1[slot] = 1; // repurpose b1 as "impulse pending" flag (b1 is always 0 for BPF)
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

    // Stochastic Poisson trigger
    const blockDuration = blockSize / this.sr;
    this.nextEvent -= blockDuration;
    while (this.nextEvent <= 0) {
      this.spawnEvent();
      // Exponential inter-arrival time (true Poisson process)
      const rate = Math.max(0.01, this.current.rate);
      this.nextEvent += -Math.log(1 - Math.random()) / rate;
    }

    const twoPiOverSr = 2 * Math.PI / this.sr;
    const density = this.current.density;

    for (let s = 0; s < blockSize; s++) {
      let sum = 0;

      for (let i = 0; i < this.N; i++) {
        if (!this.active[i]) continue;

        let sample = 0;

        if (this.transLeft[i] > 0) {
          // Shaped noise transient: linear decay envelope
          const env = this.transLeft[i] / this.transLen[i];
          sample = this.amp[i] * (Math.random() * 2 - 1) * env;
          this.transLeft[i]--;
        } else if (this.useRes[i]) {
          // Biquad resonator
          // Inject impulse on first sample (b1 repurposed as flag)
          const impulse = this.b1[i] > 0 ? 1.0 : 0;
          if (impulse) this.b1[i] = 0; // clear flag
          const y = this.b0[i] * impulse - this.a1[i] * this.z1[i] - this.a2[i] * this.z2[i];
          this.z2[i] = this.z1[i];
          this.z1[i] = y;
          sample = y * this.amp[i];
        } else {
          // Damped sinusoid with chirp
          sample = this.amp[i] * Math.sin(this.phase[i]);
          this.phase[i] += this.freq[i] * twoPiOverSr;
          this.freq[i] += this.evChirp[i];
          // Phase wrap to avoid precision loss
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

      out[s] = sum * density;
    }

    return true;
  }
}

registerProcessor("swarm-processor", SwarmProcessor);
