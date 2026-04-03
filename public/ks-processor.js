/**
 * Karplus-Strong Worklet — plucked string synthesis
 * Parameters via AudioParam: frequency, damping, brightness, amplitude
 * Excite trigger via MessagePort.
 */

class KSProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency",  defaultValue: 220, automationRate: "k-rate" },
      { name: "damping",    defaultValue: 0.5, automationRate: "k-rate" },
      { name: "brightness", defaultValue: 0.8, automationRate: "k-rate" },
      { name: "amplitude",  defaultValue: 0.5, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.sr = sampleRate;
    this.maxDelay = Math.ceil(this.sr / 20);
    this.delayLine = new Float32Array(this.maxDelay);
    this.writeIdx = 0;
    this.lpState = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === "excite") this.excite(e.data);
    };
  }

  excite(msg) {
    const freq = msg.frequency || 220;
    const brightness = msg.brightness || 0.8;
    const period = Math.round(this.sr / freq);
    let prev = 0;
    for (let i = 0; i < period && i < this.maxDelay; i++) {
      const noise = Math.random() * 2 - 1;
      const filtered = prev + brightness * (noise - prev);
      prev = filtered;
      this.delayLine[(this.writeIdx + i) % this.maxDelay] = filtered;
    }
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0]?.[0];
    if (!out) return true;

    const freq = parameters.frequency[0];
    const damping = parameters.damping[0];
    const amp = parameters.amplitude[0];
    if (freq <= 20 || amp < 0.0001) { out.fill(0); return true; }

    const exactDelay = this.sr / freq;
    const intDelay = Math.floor(exactDelay);
    const frac = exactDelay - intDelay;
    const lpCoeff = damping * 0.5;

    for (let s = 0; s < out.length; s++) {
      const r1 = (this.writeIdx - intDelay + this.maxDelay) % this.maxDelay;
      const r2 = (this.writeIdx - intDelay - 1 + this.maxDelay) % this.maxDelay;
      const sample = this.delayLine[r1] * (1 - frac) + this.delayLine[r2] * frac;

      this.lpState = sample * (1 - lpCoeff) + this.lpState * lpCoeff;
      this.delayLine[this.writeIdx] = this.lpState * 0.996;
      this.writeIdx = (this.writeIdx + 1) % this.maxDelay;

      out[s] = sample * amp;
    }
    return true;
  }
}

registerProcessor("ks-processor", KSProcessor);
