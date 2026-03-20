/**
 * 4-line FDN Reverb Worklet
 *
 * Mono in, mono out. Allpass input diffusion, Hadamard feedback matrix,
 * one-pole LP in feedback, LFO modulation on delay taps, DC blocker.
 */

class ReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "size",     defaultValue: 0.5, automationRate: "k-rate" },
      { name: "decay",    defaultValue: 0.5, automationRate: "k-rate" },
      { name: "absorb",   defaultValue: 0.5, automationRate: "k-rate" },
      { name: "mix",      defaultValue: 0.3, automationRate: "k-rate" },
      { name: "modSpeed", defaultValue: 0.5, automationRate: "k-rate" },
      { name: "modDepth", defaultValue: 0.3, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.sr = sr;

    // 4 delay lines with mutually prime lengths
    this.baseDelays = [1087, 1283, 1511, 1753];
    this.maxLen = 2048; // enough headroom
    this.lines = [];
    for (let i = 0; i < 4; i++) this.lines.push(new Float32Array(this.maxLen));
    this.writePos = 0;

    // Feedback LP states
    this.lp = new Float32Array(4);

    // LFO phases (staggered)
    this.lfoPhase = [0, 1.57, 3.14, 4.71];

    // Allpass buffers
    this.ap1 = { buf: new Float32Array(53), idx: 0 };
    this.ap2 = { buf: new Float32Array(79), idx: 0 };

    // DC blocker
    this.dcX = 0;
    this.dcY = 0;

    // Params
    this.p = { size: 0.5, decay: 0.5, absorb: 0.5, mix: 0.3, modSpeed: 0.5, modDepth: 0.3 };
    this.audioConnectedParams = new Set();

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "params") {
        for (const k of Object.keys(this.p)) if (msg[k] !== undefined) this.p[k] = msg[k];
      } else if (msg.type === "audioConnected") {
        this.audioConnectedParams = new Set(msg.params);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const inp = inputs[0]?.[0];
    const n = out.length;
    const p = this.p;

    // Read audio-connected params
    for (const name of this.audioConnectedParams) {
      const ap = parameters[name];
      if (ap?.length > 0) p[name] = ap[0];
    }

    const g = 0.6; // allpass coeff
    const feedback = p.decay >= 0.999 ? 1.0 : p.decay;
    const lpC = p.absorb * 0.7;
    const lfoRate = p.modSpeed * 0.3;
    const lfoDepth = p.modDepth * 12;

    for (let s = 0; s < n; s++) {
      let x = inp ? inp[s] : 0;

      // Allpass 1
      const ad1 = this.ap1.buf[this.ap1.idx];
      this.ap1.buf[this.ap1.idx] = x + g * ad1;
      x = ad1 - g * (x + g * ad1);  // simplified: output = delayed - g * written
      this.ap1.idx = (this.ap1.idx + 1) % 53;

      // Allpass 2
      const ad2 = this.ap2.buf[this.ap2.idx];
      this.ap2.buf[this.ap2.idx] = x + g * ad2;
      x = ad2 - g * (x + g * ad2);
      this.ap2.idx = (this.ap2.idx + 1) % 79;

      const inject = x * 0.5;

      // Read taps
      const taps = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        const dl = this.baseDelays[i] * (0.05 + p.size * 0.95);
        const mod = Math.sin(this.lfoPhase[i]) * lfoDepth;
        const rd = dl + mod;
        const ri = Math.floor(rd);
        const rf = rd - ri;
        const p1 = (this.writePos - ri + this.maxLen) % this.maxLen;
        const p2 = (this.writePos - ri - 1 + this.maxLen) % this.maxLen;
        taps[i] = this.lines[i][p1] * (1 - rf) + this.lines[i][p2] * rf;
        this.lfoPhase[i] += 6.2832 * lfoRate / this.sr;
      }

      // Hadamard mix
      const h = [
        0.5 * (taps[0] + taps[1] + taps[2] + taps[3]),
        0.5 * (taps[0] - taps[1] + taps[2] - taps[3]),
        0.5 * (taps[0] + taps[1] - taps[2] - taps[3]),
        0.5 * (taps[0] - taps[1] - taps[2] + taps[3]),
      ];

      // LP + feedback + inject → write
      for (let i = 0; i < 4; i++) {
        this.lp[i] = h[i] * (1 - lpC) + this.lp[i] * lpC;
        this.lines[i][this.writePos] = this.lp[i] * feedback + inject;
      }
      this.writePos = (this.writePos + 1) % this.maxLen;

      // Output
      const wet = 0.5 * (taps[0] + taps[1] + taps[2] + taps[3]);
      const dry = inp ? inp[s] : 0;
      const mixed = dry * (1 - p.mix) + wet * p.mix;

      // DC blocker
      this.dcY = mixed - this.dcX + 0.995 * this.dcY;
      this.dcX = mixed;
      out[s] = this.dcY;
    }
    return true;
  }
}

registerProcessor("reverb-processor", ReverbProcessor);
