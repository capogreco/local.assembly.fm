/**
 * Cosine — audio-rate shaped hump envelope (returns to zero).
 * Phase-distorted cosine with variable duty and curve.
 * Numeric params via AudioParam, trigger via MessagePort.
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
  static get parameterDescriptors() {
    return [
      { name: "amplitude", defaultValue: 1,   automationRate: "k-rate" },
      { name: "duration",  defaultValue: 0.5, automationRate: "k-rate" },
      { name: "duty",      defaultValue: 0.5, automationRate: "k-rate" },
      { name: "curve",     defaultValue: 1,   automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.value = 0;
    this.phase = "idle";
    this.elapsed = 0;
    this.mode = "respect";
    this._pendingTrigger = false;
    this.port.onmessage = (e) => {
      if (e.data.type === "trigger") {
        if (this.mode === "respect" && this.phase === "running") return;
        this._pendingTrigger = true;
      }
      if (e.data.mode !== undefined) this.mode = e.data.mode;
    };
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0]?.[0];
    if (!out) return true;

    const amp = parameters.amplitude[0];
    if (this._pendingTrigger) {
      this._pendingTrigger = false;
      this.phase = "running";
      this.elapsed = 0;
    }
    const duration = Math.max(0.001, parameters.duration[0]);
    const duty = parameters.duty[0];
    const curve = parameters.curve[0];
    const dt = 1 / sampleRate;
    let ended = false;

    for (let i = 0; i < out.length; i++) {
      if (this.phase === "running") {
        this.elapsed += dt;
        const t = Math.min(1, this.elapsed / duration);
        this.value = amp * cosineShape(t, duty, curve);
        if (t >= 1) { this.value = 0; this.phase = "idle"; ended = true; }
      }
      out[i] = this.value;
    }
    if (ended) this.port.postMessage({ type: "end" });
    return true;
  }
}

registerProcessor("cosine-processor", CosineProcessor);
