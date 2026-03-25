/**
 * Sigmoid — audio-rate shaped transition from start to end.
 * Phase-distorted sigmoid with variable duty and curve.
 * Numeric params via AudioParam, trigger via MessagePort.
 */

function sigmoidShape(t, duty, curve) {
  const d = Math.max(0.001, Math.min(0.999, duty));
  let phi;
  if (t <= d) phi = 0.5 * t / d;
  else phi = 0.5 + 0.5 * (t - d) / (1 - d);
  if (curve < 0.1) return phi;
  const raw = x => 1 / (1 + Math.exp(-curve * (x - 0.5)));
  const r0 = raw(0), r1 = raw(1);
  return (raw(phi) - r0) / (r1 - r0);
}

class SigmoidProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "start",    defaultValue: 0,   automationRate: "k-rate" },
      { name: "end",      defaultValue: 1,   automationRate: "k-rate" },
      { name: "duration", defaultValue: 0.5, automationRate: "k-rate" },
      { name: "duty",     defaultValue: 0.5, automationRate: "k-rate" },
      { name: "curve",    defaultValue: 6,   automationRate: "k-rate" },
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

    const start = parameters.start[0];
    // Handle trigger with fresh param values
    if (this._pendingTrigger) {
      this._pendingTrigger = false;
      this._startVal = start;
      this.value = start;
      this.phase = "running";
      this.elapsed = 0;
    }
    const end = parameters.end[0];
    const duration = Math.max(0.001, parameters.duration[0]);
    const duty = parameters.duty[0];
    const curve = parameters.curve[0];
    const dt = 1 / sampleRate;
    let ended = false;

    for (let i = 0; i < out.length; i++) {
      if (this.phase === "running") {
        this.elapsed += dt;
        const t = Math.min(1, this.elapsed / duration);
        this.value = this._startVal + (end - this._startVal) * sigmoidShape(t, duty, curve);
        if (t >= 1) { this.value = end; this.phase = "idle"; ended = true; }
      }
      out[i] = this.value;
    }
    if (ended) this.port.postMessage({ type: "end" });
    return true;
  }
}

registerProcessor("sigmoid-processor", SigmoidProcessor);
