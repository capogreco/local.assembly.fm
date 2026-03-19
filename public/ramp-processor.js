/**
 * Ramp — audio-rate linear interpolation from→to over duration.
 * Triggered via message port: { type: "trigger", from, to, duration }
 * Posts { type: "end" } on completion.
 */
class RampProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [];
  }

  constructor() {
    super();
    this.value = 0;
    this.from = 0;
    this.to = 1;
    this.duration = 0.5;
    this.phase = "idle";
    this.elapsed = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "trigger") {
        if (e.data.from !== undefined) this.from = e.data.from;
        if (e.data.to !== undefined) this.to = e.data.to;
        if (e.data.duration !== undefined) this.duration = Math.max(0.001, e.data.duration);
        this.value = this.from;
        this.phase = "running";
        this.elapsed = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const dt = 1 / sampleRate;
    let ended = false;

    for (let i = 0; i < out.length; i++) {
      if (this.phase === "running") {
        this.elapsed += dt;
        const t = Math.min(1, this.elapsed / this.duration);
        this.value = this.from + (this.to - this.from) * t;
        if (t >= 1) { this.phase = "idle"; ended = true; }
      }
      out[i] = this.value;
    }
    if (ended) this.port.postMessage({ type: "end" });
    return true;
  }
}

registerProcessor("ramp-processor", RampProcessor);
