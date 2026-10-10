/**
 * LFO — audio-rate sine oscillator for modulation.
 * Output: single channel, unipolar (0–1) or bipolar (−1–1).
 * Controlled via message port: { bipolar, phase }
 */
class LFOProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "period", defaultValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
    this.bipolar = false;
    this.port.onmessage = (e) => {
      if (e.data.bipolar !== undefined) this.bipolar = !!e.data.bipolar;
      if (e.data.phase !== undefined) this.phase = e.data.phase;
    };
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const period = Math.max(0.001, parameters.period[0]);
    const inc = 1 / (period * sampleRate);
    for (let i = 0; i < out.length; i++) {
      const raw = Math.sin(this.phase * 2 * Math.PI);
      out[i] = this.bipolar ? raw : raw * 0.5 + 0.5;
      this.phase += inc;
      if (this.phase >= 1) this.phase -= 1;
    }
    return true;
  }
}

registerProcessor("lfo-processor", LFOProcessor);
