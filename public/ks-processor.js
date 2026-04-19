/**
 * Karplus-Strong Worklet — plucked string synthesis
 * Parameters via AudioParam: frequency, damping, brightness, excitation, amplitude
 * Rising edge on excitation (crosses above 0.5) triggers a pluck.
 */

class KSProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency",  defaultValue: 220, automationRate: "k-rate" },
      { name: "damping",    defaultValue: 0.996, automationRate: "k-rate" },
      { name: "brightness", defaultValue: 0.8, automationRate: "k-rate" },
      { name: "excitation", defaultValue: 0,   automationRate: "a-rate" },
      { name: "amplitude",  defaultValue: 0.5, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.maxLen = Math.ceil(sampleRate / 20); // longest delay line: 20 Hz
    this.buf = new Float32Array(this.maxLen);
    this.writePos = 0;
    this.lpPrev = 0;
    this.excPrev = 0;
  }

  pluck(delay, brightness) {
    // Write filtered noise burst at the READ positions (behind writePos).
    // The process loop reads from (writePos - delay), so that's where the noise must go.
    let prev = 0;
    const len = Math.min(delay, this.maxLen);
    for (let i = 0; i < len; i++) {
      const noise = Math.random() * 2 - 1;
      const sample = prev + brightness * (noise - prev);
      prev = sample;
      this.buf[(this.writePos - delay + i + this.maxLen) % this.maxLen] = sample;
    }
    this.lpPrev = 0;
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;

    const freq = parameters.frequency[0];
    const damp = parameters.damping[0];
    const brightness = parameters.brightness[0];
    const amp = parameters.amplitude[0];
    const excArr = parameters.excitation;

    const delay = Math.min(Math.round(sampleRate / Math.max(freq, 20)), this.maxLen);

    // Edge-detect excitation
    for (let i = 0; i < excArr.length; i++) {
      const exc = excArr.length > 1 ? excArr[i] : excArr[0];
      if (exc > 0.5 && this.excPrev <= 0.5) {
        this.pluck(delay, brightness);
      }
      this.excPrev = exc;
    }

    for (let s = 0; s < out.length; s++) {
      // Read from delay samples behind write position
      const readPos = (this.writePos - delay + this.maxLen) % this.maxLen;
      const cur = this.buf[readPos];

      // KS filter: average current + previous, scale by damping
      const filtered = damp * 0.5 * (cur + this.lpPrev);
      this.lpPrev = cur;

      // Output the raw delay line sample (before filtering)
      out[s] = cur * amp;

      // Write filtered sample back — this is what gets read `delay` samples from now
      this.buf[this.writePos] = filtered;
      this.writePos = (this.writePos + 1) % this.maxLen;
    }

    return true;
  }
}

registerProcessor("ks-processor", KSProcessor);
