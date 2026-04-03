/**
 * Ramp — audio-rate interpolation from→to over duration with curve shaping.
 * curve=1 linear, curve>1 exponential (slow start), curve<1 logarithmic (fast start).
 * Numeric params via AudioParam, trigger via MessagePort.
 */

class RampProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "from",     defaultValue: 0,   automationRate: "k-rate" },
      { name: "to",       defaultValue: 1,   automationRate: "k-rate" },
      { name: "duration", defaultValue: 0.5, automationRate: "k-rate" },
      { name: "curve",    defaultValue: 1,   automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.value = 0;
    this._from = 0;
    this.phase = "idle";
    this.elapsed = 0;
    this._pendingTrigger = false;
    this.port.onmessage = (e) => {
      if (e.data.type === "trigger") {
        this._pendingTrigger = true;
      }
    };
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0]?.[0];
    if (!out) return true;

    const from = parameters.from[0];
    if (this._pendingTrigger) {
      this._pendingTrigger = false;
      this._from = from;
      this.value = from;
      this.phase = "running";
      this.elapsed = 0;
    }
    const to = parameters.to[0];
    const duration = Math.max(0.001, parameters.duration[0]);
    const curve = parameters.curve[0];
    const dt = 1 / sampleRate;
    let ended = false;

    for (let i = 0; i < out.length; i++) {
      if (this.phase === "running") {
        this.elapsed += dt;
        const t = Math.min(1, this.elapsed / duration);
        const shaped = curve === 1 ? t : Math.pow(t, curve);
        this.value = this._from + (to - this._from) * shaped;
        if (t >= 1) { this.phase = "idle"; ended = true; }
      }
      out[i] = this.value;
    }
    if (ended) this.port.postMessage({ type: "end" });
    return true;
  }
}

registerProcessor("ramp-processor", RampProcessor);
