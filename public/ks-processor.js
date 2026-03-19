/**
 * Karplus-Strong Worklet — plucked string synthesis
 *
 * Parameters controlled via message port with portamento smoothing.
 * Excite trigger fills delay line with brightness-filtered noise burst.
 * Single mono output channel.
 */

class KSProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency",  defaultValue: 220, automationRate: "k-rate" },
      { name: "damping",    defaultValue: 0.5, automationRate: "k-rate" },
      { name: "brightness", defaultValue: 0.8, automationRate: "k-rate" },
      { name: "amplitude",  defaultValue: 0.0, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();

    this.sr = sampleRate;

    // Delay line sized for ~20 Hz minimum
    this.maxDelay = Math.ceil(this.sr / 20);
    this.delayLine = new Float32Array(this.maxDelay);
    this.writeIdx = 0;

    // One-pole LP filter state
    this.lpState = 0;

    // Portamento targets and current values
    this.targets = {
      frequency: 220,
      damping: 0.5,
      brightness: 0.8,
      amplitude: 0.0,
    };
    this.current = { ...this.targets };

    // Portamento alpha: 1 = instant (no smoothing)
    this.portamentoAlpha = 1;

    // Params connected to audio-rate modulation sources
    this.audioConnectedParams = new Set();

    // Message port for parameter updates and excite triggers
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "params") {
        for (const key of Object.keys(this.targets)) {
          if (msg[key] !== undefined) {
            this.targets[key] = msg[key];
          }
        }
      } else if (msg.type === "excite") {
        this.excite();
      } else if (msg.type === "audioConnected") {
        this.audioConnectedParams = new Set(msg.params || []);
      }
    };
  }

  excite() {
    const freq = this.targets.frequency;
    if (freq <= 0) return;

    const period = Math.round(this.sr / freq);
    const brightness = this.targets.brightness;

    // Fill one period of delay line with brightness-filtered noise
    let prev = 0;
    for (let i = 0; i < period && i < this.maxDelay; i++) {
      const noise = Math.random() * 2 - 1;
      // Simple one-pole LP for brightness control
      const filtered = prev + brightness * (noise - prev);
      prev = filtered;
      const idx = (this.writeIdx + i) % this.maxDelay;
      this.delayLine[idx] = filtered;
    }
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const out = output[0];
    const blockSize = out.length;
    const alpha = this.portamentoAlpha;

    // For audio-connected params: read directly from AudioParam (no smoothing)
    for (const name of this.audioConnectedParams) {
      const p = parameters[name];
      if (p && p.length > 0) {
        this.current[name] = p[0];
        this.targets[name] = p[0];
      }
    }

    for (let s = 0; s < blockSize; s++) {
      // Portamento smoothing (only for non-audio-connected params)
      for (const key of Object.keys(this.targets)) {
        if (this.audioConnectedParams.has(key)) continue;
        this.current[key] += alpha * (this.targets[key] - this.current[key]);
      }

      const freq = this.current.frequency;
      const damping = this.current.damping;
      const amplitude = this.current.amplitude;

      if (freq <= 20 || amplitude <= 0.0001) {
        out[s] = 0;
        continue;
      }

      // Fractional delay for accurate pitch
      const exactDelay = this.sr / freq;
      const intDelay = Math.floor(exactDelay);
      const frac = exactDelay - intDelay;

      // Read from delay line with linear interpolation
      const readIdx1 = (this.writeIdx - intDelay + this.maxDelay) % this.maxDelay;
      const readIdx2 = (this.writeIdx - intDelay - 1 + this.maxDelay) % this.maxDelay;
      const sample = this.delayLine[readIdx1] * (1 - frac) + this.delayLine[readIdx2] * frac;

      // One-pole LP feedback filter (damping control)
      // damping 0 = bright (no filtering), damping 1 = dark (heavy filtering)
      const lpCoeff = damping * 0.5;
      this.lpState = sample * (1 - lpCoeff) + this.lpState * lpCoeff;

      // Write filtered sample back to delay line (feedback)
      const feedback = 0.996; // slight loss to prevent infinite sustain
      this.delayLine[this.writeIdx] = this.lpState * feedback;

      this.writeIdx = (this.writeIdx + 1) % this.maxDelay;

      out[s] = sample * amplitude;
    }

    return true;
  }
}

registerProcessor("ks-processor", KSProcessor);
