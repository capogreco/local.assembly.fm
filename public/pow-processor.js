/**
 * Pow — audio-rate exponentiation: base^input or input^exp.
 * Two modes controlled by args:
 *   Default: output = input[0] ^ exp (AudioParam)
 *   "base N": output = N ^ input[0]
 */
class PowProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "exp", defaultValue: 2, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.baseMode = false; // if true: output = base ^ input
    this.base = 2;
    this.port.onmessage = (e) => {
      if (e.data.type === "params") {
        if (e.data.base !== undefined) { this.baseMode = true; this.base = e.data.base; }
        if (e.data.exp !== undefined) this.baseMode = false;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const inp = inputs[0]?.[0];
    const exp = parameters.exp[0];

    for (let i = 0; i < out.length; i++) {
      const x = inp ? inp[i] : 0;
      out[i] = this.baseMode ? Math.pow(this.base, x) : Math.pow(x, exp);
    }
    return true;
  }
}

registerProcessor("pow-processor", PowProcessor);
