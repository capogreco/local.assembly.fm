/**
 * Named sample buffers and play~.
 *
 * Every processor in an AudioContext shares one AudioWorkletGlobalScope, so
 * this module-level map holds one copy of each buffer for every play~ (and a
 * later record~). The main thread decodes, mixes to mono and transfers the
 * samples once to the registry node (engine-factory.js syncBuffers); no
 * SharedArrayBuffer.
 */
const BUFFERS = new Map(); // name → Float32Array (mono)

// The registry: one node per AudioContext, never connected. It only receives
// { type: "set", name, samples } and { type: "delete", name }.
class BufferRegistryProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === "set") BUFFERS.set(d.name, d.samples);
      else if (d.type === "delete") BUFFERS.delete(d.name);
    };
  }

  // No audio work, but return true: false lets the browser end the processor,
  // and a buffer set or deleted after that would never arrive.
  process() {
    return true;
  }
}

/**
 * play~ name — reads the named buffer at a position signal (0–1 of the
 * buffer, wrapping) with 4-point cubic Hermite interpolation. Silence while
 * the buffer is missing or the position inlet is unconnected. The buffer is
 * looked up every render quantum, so one registered (or replaced) after this
 * node was made is found.
 */
class PlayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.name = options.processorOptions?.name ?? "";
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const pos = inputs[0]?.[0];
    const buf = BUFFERS.get(this.name);
    if (!pos || !buf || buf.length === 0) {
      out.fill(0);
      return true;
    }
    const len = buf.length;
    for (let i = 0; i < out.length; i++) {
      const p = pos[i];
      if (!Number.isFinite(p)) { out[i] = 0; continue; }
      const x = (p - Math.floor(p)) * len;
      let i1 = Math.floor(x);
      const f = x - i1;
      if (i1 >= len) i1 -= len; // p just below 1 can round up to len
      const i0 = i1 === 0 ? len - 1 : i1 - 1;
      const i2 = i1 + 1 >= len ? i1 + 1 - len : i1 + 1;
      const i3 = i2 + 1 >= len ? i2 + 1 - len : i2 + 1;
      const y0 = buf[i0], y1 = buf[i1], y2 = buf[i2], y3 = buf[i3];
      const c1 = 0.5 * (y2 - y0);
      const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
      const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
      out[i] = ((c3 * f + c2) * f + c1) * f + y1;
    }
    return true;
  }
}

registerProcessor("buffer-registry", BufferRegistryProcessor);
registerProcessor("play-processor", PlayProcessor);
