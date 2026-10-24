/**
 * Output guard: replaces NaN samples with silence and reports how many it saw.
 * Sits in front of the output clamp (a clamp cannot catch NaN). The report is
 * the debugging aid: a NaN here means some engine upstream is broken.
 */
class OutputGuard extends AudioWorkletProcessor {
  constructor() {
    super();
    this.count = 0;
    this.reported = 0;
    this.lastReport = -Infinity;
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    let bad = 0;
    for (let c = 0; c < output.length; c++) {
      const i = input[c], o = output[c];
      if (!i) continue; // output channels start as zeros
      for (let k = 0; k < o.length; k++) {
        const x = i[k];
        if (x !== x) { o[k] = 0; bad++; } else o[k] = x;
      }
    }
    this.count += bad;
    if (this.count !== this.reported && currentTime - this.lastReport >= 1) {
      this.port.postMessage({ type: "nan", count: this.count });
      this.reported = this.count;
      this.lastReport = currentTime;
    }
    return true;
  }
}

registerProcessor("output-guard", OutputGuard);
