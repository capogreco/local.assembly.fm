/**
 * Trig Worklet — CV trigger pulse
 * Outputs amplitude for a fixed number of samples, then drops to 0.
 * Duration specified in samples (default 64 ≈ 1.3ms at 48kHz).
 * Trigger via MessagePort, params via AudioParam.
 */

class TrigProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "amplitude", defaultValue: 1,  automationRate: "k-rate" },
      { name: "samples",   defaultValue: 64, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.active = false;
    this.remaining = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "trigger") {
        this.active = true;
        this.remaining = -1;
      }
    };
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const amp = parameters.amplitude[0];
    const samp = Math.max(1, Math.round(parameters.samples[0]));

    if (this.remaining === -1) this.remaining = samp;

    for (let i = 0; i < out.length; i++) {
      if (this.active) {
        out[i] = amp;
        this.remaining--;
        if (this.remaining <= 0) { this.active = false; this.remaining = 0; }
      } else {
        out[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor("trig-processor", TrigProcessor);
