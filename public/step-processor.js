/**
 * Step Worklet — triggered one-shot gate
 * Jumps to amplitude, holds for length seconds, drops to 0.
 * Trigger via MessagePort, params via AudioParam.
 */

class StepProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "amplitude", defaultValue: 1,   automationRate: "k-rate" },
      { name: "length",    defaultValue: 0.5, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.active = false;
    this.remaining = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "trigger") {
        this.active = true;
        this.remaining = -1; // will be set from param in process
      }
    };
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const amp = parameters.amplitude[0];
    const len = parameters.length[0];

    if (this.remaining === -1) this.remaining = len * sampleRate;

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

registerProcessor("step-processor", StepProcessor);
