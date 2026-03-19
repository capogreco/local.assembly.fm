/**
 * AR envelope — audio-rate attack/release.
 * Triggered via message port: { type: "trigger" }
 * Posts { type: "end" } when release completes.
 */
class ARProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "attack", defaultValue: 0.1, minValue: 0.001, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.5, minValue: 0.001, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.value = 0;
    this.phase = "idle"; // idle, attack, release
    this.elapsed = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "trigger") {
        this.phase = "attack";
        this.elapsed = 0;
      }
    };
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const attack = parameters.attack[0];
    const release = parameters.release[0];
    const dt = 1 / sampleRate;
    let ended = false;

    for (let i = 0; i < out.length; i++) {
      if (this.phase === "attack") {
        this.elapsed += dt;
        this.value = Math.min(1, this.elapsed / attack);
        if (this.elapsed >= attack) { this.phase = "release"; this.elapsed = 0; }
      } else if (this.phase === "release") {
        this.elapsed += dt;
        this.value = Math.max(0, 1 - this.elapsed / release);
        if (this.elapsed >= release) { this.value = 0; this.phase = "idle"; ended = true; }
      }
      out[i] = this.value;
    }
    if (ended) this.port.postMessage({ type: "end" });
    return true;
  }
}

registerProcessor("ar-processor", ARProcessor);
