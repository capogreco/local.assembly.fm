/**
 * Lag — audio-rate exponential follower (smoothing).
 * Input signal via input[0] or message port: { type: "target", value }
 * Coeff param: time constant in seconds.
 */
class LagProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "coeff", defaultValue: 0.2, minValue: 0.001, automationRate: "k-rate" },
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
    const coeff = parameters.coeff[0];
    const alpha = 1 - Math.exp(-1 / (coeff * sampleRate));

    const inp = inputs[0]?.[0];

    for (let i = 0; i < out.length; i++) {
      if (inp && inp.length > 0) this.target = inp[i];
      this.value += (this.target - this.value) * alpha;
      out[i] = this.value;
    }
    return true;
  }
}

registerProcessor("lag-processor", LagProcessor);
