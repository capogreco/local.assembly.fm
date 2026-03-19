/**
 * Phasor — audio-rate ramp 0→1 over period.
 * Supports loop/once modes and pause.
 * Posts { type: "wrap" } event back on cycle end.
 */
class PhasorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "period", defaultValue: 1, minValue: 0.001, automationRate: "k-rate" },
      { name: "pause", defaultValue: 0, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
    this.loop = true;
    this.paused = false;
    this.port.onmessage = (e) => {
      if (e.data.type === "reset") { this.phase = 0; this.paused = false; }
      if (e.data.loop !== undefined) this.loop = e.data.loop;
    };
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const period = parameters.period[0];
    const paused = parameters.pause[0] > 0 || this.paused;
    const inc = 1 / (period * sampleRate);
    let wrapped = false;

    for (let i = 0; i < out.length; i++) {
      out[i] = this.phase;
      if (!paused) {
        this.phase += inc;
        if (this.phase >= 1) {
          if (this.loop) {
            this.phase -= 1;
          } else {
            this.phase = 1;
            this.paused = true;
          }
          wrapped = true;
        }
      }
    }
    if (wrapped) this.port.postMessage({ type: "wrap" });
    return true;
  }
}

registerProcessor("phasor-processor", PhasorProcessor);
