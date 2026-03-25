/**
 * White Noise Signal Worklet — audio-rate noise source for modulation
 * No parameters. Outputs white noise.
 */

class NoiseSignalProcessor extends AudioWorkletProcessor {
  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) out[i] = Math.random() * 2 - 1;
    return true;
  }
}

registerProcessor("noise-signal-processor", NoiseSignalProcessor);
