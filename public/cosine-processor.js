/**
 * Cosine — audio-rate shaped hump envelope (returns to zero).
 * Phase-distorted cosine with variable duty and curve.
 * Triggered via message port: { type: "trigger", amplitude, duration, duty, curve }
 * Posts { type: "end" } on completion.
 */

function cosineShape(t, duty, curve) {
  const d = Math.max(0.001, Math.min(0.999, duty));
  let base;
  if (t <= d) {
    base = (1 - Math.cos(Math.PI * t / d)) / 2;
  } else {
    base = (1 + Math.cos(Math.PI * (t - d) / (1 - d))) / 2;
  }
  return Math.pow(base, curve);
}

class CosineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.value = 0;
    this.amplitude = 1;
    this.duration = 0.5;
    this.duty = 0.5;
    this.curve = 1;
    this.phase = "idle";
    this.elapsed = 0;
    this.mode = "respect";
    this.port.onmessage = (e) => {
      if (e.data.type === "trigger") {
        if (this.mode === "respect" && this.phase === "running") return;
        if (e.data.amplitude !== undefined) this.amplitude = e.data.amplitude;
        if (e.data.duration !== undefined) this.duration = Math.max(0.001, e.data.duration);
        if (e.data.duty !== undefined) this.duty = e.data.duty;
        if (e.data.curve !== undefined) this.curve = e.data.curve;
        this.phase = "running";
        this.elapsed = 0;
      }
      if (e.data.type === "params") {
        if (e.data.amplitude !== undefined) this.amplitude = e.data.amplitude;
        if (e.data.duration !== undefined) this.duration = Math.max(0.001, e.data.duration);
        if (e.data.duty !== undefined) this.duty = e.data.duty;
        if (e.data.curve !== undefined) this.curve = e.data.curve;
        if (e.data.mode !== undefined) this.mode = e.data.mode;
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
        this.value = this.amplitude * cosineShape(t, this.duty, this.curve);
        if (t >= 1) { this.value = 0; this.phase = "idle"; ended = true; }
      }
      out[i] = this.value;
    }
    if (ended) this.port.postMessage({ type: "end" });
    return true;
  }
}

registerProcessor("cosine-processor", CosineProcessor);
