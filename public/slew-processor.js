/**
 * Slew — audio-rate rate-limited follower (portamento).
 * Input signal via input[0] or message port: { type: "target", value }
 * Rate param: time in seconds for full 0→1 traverse.
 */
class SlewProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rate", defaultValue: 0.05, minValue: 0.001, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.value = 0;
    this.target = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "target") this.target = e.data.value;
    };
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const rate = parameters.rate[0];
    const maxDelta = 1 / (rate * sampleRate);

    // If audio input is connected, use it as target
    const inp = inputs[0]?.[0];

    for (let i = 0; i < out.length; i++) {
      if (inp && inp.length > 0) this.target = inp[i];
      const diff = this.target - this.value;
      if (Math.abs(diff) > 0.0000001) {
        this.value += Math.sign(diff) * Math.min(Math.abs(diff), maxDelta);
      }
      out[i] = this.value;
    }
    return true;
  }
}

registerProcessor("slew-processor", SlewProcessor);
