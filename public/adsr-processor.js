/**
 * ADSR envelope — audio-rate, gate-driven.
 * Gate via message port: { type: "gate", value: 1|0 }
 * Posts { type: "end" } when release completes.
 */
class ADSRProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "a", defaultValue: 0.05, minValue: 0.001, automationRate: "k-rate" },
      { name: "d", defaultValue: 0.1, minValue: 0.001, automationRate: "k-rate" },
      { name: "s", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "r", defaultValue: 0.3, minValue: 0.001, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.value = 0;
    this.phase = "idle"; // idle, attack, decay, sustain, release
    this.elapsed = 0;
    this.gateOpen = false;
    this.releaseStartVal = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "gate") {
        const gateNow = e.data.value > 0;
        if (gateNow && !this.gateOpen) {
          this.gateOpen = true;
          this.phase = "attack";
          this.elapsed = 0;
        } else if (!gateNow && this.gateOpen) {
          this.gateOpen = false;
          if (this.phase !== "idle") {
            this.releaseStartVal = this.value;
            this.phase = "release";
            this.elapsed = 0;
          }
        }
      }
    };
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const a = parameters.a[0];
    const d = parameters.d[0];
    const s = parameters.s[0];
    const r = parameters.r[0];
    const dt = 1 / sampleRate;
    let ended = false;

    for (let i = 0; i < out.length; i++) {
      if (this.phase === "attack") {
        this.elapsed += dt;
        this.value = Math.min(1, this.elapsed / a);
        if (this.elapsed >= a) { this.phase = "decay"; this.elapsed = 0; }
      } else if (this.phase === "decay") {
        this.elapsed += dt;
        this.value = 1 - (1 - s) * Math.min(1, this.elapsed / d);
        if (this.elapsed >= d) { this.phase = "sustain"; this.value = s; }
      } else if (this.phase === "sustain") {
        this.value = s;
      } else if (this.phase === "release") {
        this.elapsed += dt;
        this.value = this.releaseStartVal * Math.max(0, 1 - this.elapsed / r);
        if (this.elapsed >= r) { this.value = 0; this.phase = "idle"; ended = true; }
      }
      out[i] = this.value;
    }
    if (ended) this.port.postMessage({ type: "end" });
    return true;
  }
}

registerProcessor("adsr-processor", ADSRProcessor);
