/**
 * Math processor — general-purpose audio-rate math operations.
 * Handles: +, -, *, /, **, %, scale, clip, mtof, sine, tri, quantize
 * Configured via processorOptions: { op, args }
 * Two audio inputs (input[0] = a, input[1] = b).
 * If input[1] not connected, uses `arg` value (set via message port).
 */
class MathProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.op = opts.op || "+";
    this.arg = opts.arg ?? 0;
    this.arg2 = opts.arg2 ?? 1;
    this.port.onmessage = (e) => {
      if (e.data.arg !== undefined) this.arg = e.data.arg;
      if (e.data.arg2 !== undefined) this.arg2 = e.data.arg2;
    };
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const a = inputs[0]?.[0];
    const b = inputs[1]?.[0];
    const hasB = b && b.length > 0;

    for (let i = 0; i < out.length; i++) {
      const x = a ? a[i] : 0;
      const y = hasB ? b[i] : this.arg;
      switch (this.op) {
        case "+": out[i] = x + y; break;
        case "-": out[i] = x - y; break;
        case "*": out[i] = x * y; break;
        case "/": out[i] = y !== 0 ? x / y : 0; break;
        case "%": out[i] = y !== 0 ? x % y : 0; break;
        case "**": case "pow": out[i] = Math.pow(x, y); break;
        case "scale": out[i] = x * (this.arg2 - this.arg) + this.arg; break;
        case "clip": out[i] = Math.max(this.arg, Math.min(this.arg2, x)); break;
        case "mtof": out[i] = 440 * Math.pow(2, (x - 69) / 12); break;
        case "sine": out[i] = Math.sin(x * Math.PI * 2) * 0.5 + 0.5; break;
        case "tri": {
          const yaw = this.arg || 0.5;
          out[i] = x < yaw ? (yaw > 0 ? x / yaw : 0) : (yaw < 1 ? (1 - x) / (1 - yaw) : 0);
          break;
        }
        case "quantize": {
          const divs = this.arg || 12;
          out[i] = Math.round(x * divs) / divs;
          break;
        }
        default: out[i] = x; break;
      }
    }
    return true;
  }
}

registerProcessor("math-processor", MathProcessor);
