/**
 * samphold~ — sample and hold, as in Pd.
 * Input 0 (trig): samples input 1 whenever trig decreases (a phasor wrap).
 * Input 1 (in): the signal that is sampled.
 * The first frame always samples, so the output starts at `in` rather than 0
 * (Pd starts at 0 and waits for the first decrease).
 * An unconnected input reads as 0.
 */
class SampHoldProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lastTrig = Infinity;
    this.held = 0;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const trig = inputs[0]?.[0];
    const sig = inputs[1]?.[0];
    let last = this.lastTrig, held = this.held;
    for (let i = 0; i < out.length; i++) {
      const t = trig ? trig[i] : 0;
      if (t < last) held = sig ? sig[i] : 0;
      last = t;
      out[i] = held;
    }
    this.lastTrig = last;
    this.held = held;
    return true;
  }
}

registerProcessor("samphold-processor", SampHoldProcessor);
