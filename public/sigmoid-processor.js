/**
 * Sigmoid — audio-rate shaped transition from start to end.
 * Phase-distorted sigmoid with variable duty and curve.
 * Triggered via message port: { type: "trigger", start, end, duration, duty, curve }
 * Posts { type: "end" } on completion.
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
  constructor() {
    super();
    this.value = 0;
    this.start = 0;
    this.end = 1;
    this.duration = 0.5;
    this.duty = 0.5;
    this.curve = 6;
    this.phase = "idle";
    this.elapsed = 0;
    this.mode = "respect";
    this.port.onmessage = (e) => {
      if (e.data.type === "trigger") {
        if (this.mode === "respect" && this.phase === "running") return;
        if (e.data.start !== undefined) this.start = e.data.start;
        if (e.data.end !== undefined) this.end = e.data.end;
        if (e.data.duration !== undefined) this.duration = Math.max(0.001, e.data.duration);
        if (e.data.duty !== undefined) this.duty = e.data.duty;
        if (e.data.curve !== undefined) this.curve = e.data.curve;
        this.value = this.start;
        this.phase = "running";
        this.elapsed = 0;
      }
      if (e.data.type === "params") {
        if (e.data.start !== undefined) this.start = e.data.start;
        if (e.data.end !== undefined) this.end = e.data.end;
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
        const shaped = sigmoidShape(t, this.duty, this.curve);
        this.value = this.start + (this.end - this.start) * shaped;
        if (t >= 1) { this.value = this.end; this.phase = "idle"; ended = true; }
      }
      out[i] = this.value;
    }
    if (ended) this.port.postMessage({ type: "end" });
    return true;
  }
}

registerProcessor("sigmoid-processor", SigmoidProcessor);
