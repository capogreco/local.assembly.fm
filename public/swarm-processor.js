/**
 * Stochastic Event Swarm Worklet — chaos-driven resonant event synthesis
 *
 * Normalised parameter interface (0–1 across the board). Internal mappings
 * cover the "burbling creek ↔ fizzing champagne" texture axis.
 *
 * Embedded Rössler attractor replaces randomness for event parameters.
 * Chaos outputs drive: event timing (x), frequency selection (y),
 * amplitude (z). Creates temporally correlated, non-repeating events.
 */

// --- parameter mapping helpers ---

const mapLog = (t, min, max) => Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min)));
const mapBipolar = (t, range) => (t - 0.5) * 2 * range;

class SwarmProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    // All inputs 0–1. See `updateParams()` for the actual ranges.
    return [
      { name: "freqCenter",   defaultValue: 0.5, automationRate: "k-rate" },
      { name: "freqRange",    defaultValue: 0.4, automationRate: "k-rate" },
      { name: "rate",         defaultValue: 0.4, automationRate: "k-rate" },
      { name: "chirp",        defaultValue: 0.5, automationRate: "k-rate" },
      { name: "decay",        defaultValue: 0.4, automationRate: "k-rate" },
      { name: "resonatorQ",   defaultValue: 0.0, automationRate: "k-rate" },
      { name: "density",      defaultValue: 1.0, automationRate: "k-rate" },
      { name: "transientMix", defaultValue: 0.3, automationRate: "k-rate" },
      { name: "chaosSpeed",   defaultValue: 0.5, automationRate: "k-rate" },
      { name: "amplitude",    defaultValue: 0.5, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.sr = sampleRate;
    const N = 192;
    this.N = N;

    this.phase      = new Float32Array(N);
    this.freq       = new Float32Array(N);
    this.evChirp    = new Float32Array(N);
    this.chirpDecay = new Float32Array(N);
    this.amp        = new Float32Array(N);
    this.decayMul   = new Float32Array(N);
    this.transLeft  = new Int32Array(N);
    this.transLen   = new Int32Array(N);
    this.transLP    = new Float32Array(N);
    this.active     = new Uint8Array(N);

    this.useRes = new Uint8Array(N);
    this.z1     = new Float32Array(N);
    this.z2     = new Float32Array(N);
    this.b0     = new Float32Array(N);
    this.b1     = new Float32Array(N);
    this.b2     = new Float32Array(N);
    this.a1     = new Float32Array(N);
    this.a2     = new Float32Array(N);

    this.nextEvent = 0;
    this.globalLP = 0;
    this.dcX = 0;
    this.dcY = 0;

    // Embedded Rössler attractor — replaces Math.random()
    this.cx = (Math.random() - 0.5) * 2;
    this.cy = (Math.random() - 0.5) * 2;
    this.cz = (Math.random() - 0.5) * 0.5;
    this.cMaxX = 10; this.cMaxY = 10; this.cMaxZ = 5;

    // `m` holds the mapped (internal-unit) values updated per block from the
    // normalised k-rate parameters.
    this.m = {
      freqCenterHz: 1000,
      freqRangeOct: 2,
      rate: 30,
      chirpRelPerSec: 0,   // fraction of event frequency per second
      Q: 9,
      resonatorQ: 0,       // 0 = sinusoid, else biquad Q
      density: 1,
      transientMix: 0.3,
      chaosSpeed: 1,
      amplitude: 0.5,
    };
  }

  updateParams(p) {
    const m = this.m;
    m.freqCenterHz   = mapLog(p.freqCenter[0], 50, 20000);
    m.freqRangeOct   = p.freqRange[0] * 5;
    m.rate           = mapLog(p.rate[0], 2, 2000);
    m.chirpRelPerSec = mapBipolar(p.chirp[0], 1);           // ±1 = ±100 % of f per sec
    m.Q              = mapLog(p.decay[0], 1, 80);
    m.resonatorQ     = p.resonatorQ[0] < 0.01
                         ? 0
                         : mapLog((p.resonatorQ[0] - 0.01) / 0.99, 2, 100);
    m.density        = p.density[0];
    m.transientMix   = p.transientMix[0];
    // chaosSpeed log-symmetric around 0.5 → 1.0
    m.chaosSpeed     = mapLog(p.chaosSpeed[0], 0.1, 10);
    m.amplitude      = p.amplitude[0];
  }

  // Step the Rössler attractor and return normalised (0–1) values
  stepChaos(speed) {
    const a = 0.2, b = 0.2, c = 5.7;
    const dt = speed * 0.05;

    // RK4
    const dx1 = -(this.cy + this.cz);
    const dy1 = this.cx + a * this.cy;
    const dz1 = b + this.cz * (this.cx - c);
    const x2 = this.cx + dx1 * dt * 0.5, y2 = this.cy + dy1 * dt * 0.5, z2 = this.cz + dz1 * dt * 0.5;
    const dx2 = -(y2 + z2);
    const dy2 = x2 + a * y2;
    const dz2 = b + z2 * (x2 - c);
    const x3 = this.cx + dx2 * dt * 0.5, y3 = this.cy + dy2 * dt * 0.5, z3 = this.cz + dz2 * dt * 0.5;
    const dx3 = -(y3 + z3);
    const dy3 = x3 + a * y3;
    const dz3 = b + z3 * (x3 - c);
    const x4 = this.cx + dx3 * dt, y4 = this.cy + dy3 * dt, z4 = this.cz + dz3 * dt;
    const dx4 = -(y4 + z4);
    const dy4 = x4 + a * y4;
    const dz4 = b + z4 * (x4 - c);

    this.cx += (dx1 + 2 * dx2 + 2 * dx3 + dx4) * dt / 6;
    this.cy += (dy1 + 2 * dy2 + 2 * dy3 + dy4) * dt / 6;
    this.cz += (dz1 + 2 * dz2 + 2 * dz3 + dz4) * dt / 6;

    // Blow-up protection
    const mm = Math.max(Math.abs(this.cx), Math.abs(this.cy), Math.abs(this.cz));
    if (mm > 1e6 || isNaN(mm)) { this.cx = 0.1; this.cy = 0; this.cz = 0; }

    // Adaptive normalisation to 0–1
    this.cMaxX = Math.max(this.cMaxX * 0.9999, Math.abs(this.cx));
    this.cMaxY = Math.max(this.cMaxY * 0.9999, Math.abs(this.cy));
    this.cMaxZ = Math.max(this.cMaxZ * 0.9999, Math.abs(this.cz));

    return {
      x: (this.cx / this.cMaxX) * 0.5 + 0.5,
      y: (this.cy / this.cMaxY) * 0.5 + 0.5,
      z: (this.cz / this.cMaxZ) * 0.5 + 0.5,
    };
  }

  spawnEventAt(f, a, dm, chirpVal, chirpDk, hasTransient) {
    let slot = -1;
    for (let i = 0; i < this.N; i++) {
      if (!this.active[i]) { slot = i; break; }
    }
    if (slot < 0) return;

    this.active[slot] = 1;
    // Random initial phase: chaos-driven phase would correlate across events
    // spawned in the same attractor neighbourhood, summing constructively into
    // an audible pitch where none was intended.
    this.phase[slot] = Math.random() * 6.2832;
    this.freq[slot] = f;
    this.evChirp[slot] = chirpVal;
    this.chirpDecay[slot] = chirpDk;
    this.amp[slot] = a;
    this.decayMul[slot] = dm;

    if (hasTransient) {
      const len = Math.round((0.001 + this.lastChaos.z * 0.004) * this.sr);
      this.transLeft[slot] = len;
      this.transLen[slot] = len;
      this.transLP[slot] = 0;
    } else {
      this.transLeft[slot] = 0;
      this.transLen[slot] = 0;
      this.transLP[slot] = 0;
    }

    const resQ = this.m.resonatorQ;
    if (resQ > 0) {
      this.useRes[slot] = 1;
      const w0 = 6.2832 * f / this.sr;
      const alpha = Math.sin(w0) / (2 * resQ);
      const a0 = 1 + alpha;
      this.b0[slot] = alpha / a0;
      this.b1[slot] = 1;
      this.b2[slot] = -alpha / a0;
      this.a1[slot] = (-2 * Math.cos(w0)) / a0;
      this.a2[slot] = (1 - alpha) / a0;
      this.z1[slot] = 0;
      this.z2[slot] = 0;
    } else {
      this.useRes[slot] = 0;
    }
  }

  spawnEvent() {
    const m = this.m;
    const ch = this.stepChaos(m.chaosSpeed);
    this.lastChaos = ch;

    // freqCenter + freqRange → log-frequency window, sampled by chaos.y
    const halfOct = m.freqRangeOct * 0.5;
    const logCenter = Math.log(m.freqCenterHz);
    const logMin = logCenter - halfOct * Math.LN2;
    const logMax = logCenter + halfOct * Math.LN2;
    const f = Math.exp(logMin + ch.y * (logMax - logMin));

    // Chaos z drives amplitude (with 1/f correlation to tame HF harshness)
    const fRef = Math.exp((logMin + logMax) * 0.5);
    const ampScale = Math.min(fRef / f, 4.0);
    const a = ch.z * m.amplitude * ampScale;

    // Constant-Q decay from mapped Q
    const t60 = m.Q / f;
    const dm = Math.exp(-6.9 / (t60 * this.sr));

    // Chirp: frequency-proportional rate that decays quickly over the event's
    // attack — preserves the watery "plink" character at any pitch.
    const chirpVal = (m.chirpRelPerSec * f) / this.sr;
    const chirpDk = Math.exp(-10 / (0.003 * this.sr));

    // Chaos x drives transient probability
    const hasTransient = ch.x < m.transientMix;
    this.spawnEventAt(f, a, dm, chirpVal, chirpDk, hasTransient);

    // Sibling spawning — chaos-driven probability and count.
    // Sibling frequency picks a fresh point in the log-freq window using the
    // sibling's own chaos.y, rather than a fixed 0.7–1.2× multiplier around
    // the parent. That multiplier would push siblings below the user's
    // intended freqRange and cluster audibly around the low edge.
    if (ch.x > 0.7) {
      const numSiblings = 1 + Math.floor(ch.z * 3);
      for (let s = 0; s < numSiblings; s++) {
        const sibCh = this.stepChaos(m.chaosSpeed);
        const sibF = Math.exp(logMin + sibCh.y * (logMax - logMin));
        const sibAmpScale = Math.min(fRef / sibF, 4.0);
        const sibA = sibCh.z * m.amplitude * sibAmpScale * 0.5;
        const sibT60 = m.Q / sibF;
        const sibDm = Math.exp(-6.9 / (sibT60 * this.sr));
        const sibChirpVal = (m.chirpRelPerSec * sibF) / this.sr * 0.7;
        this.spawnEventAt(sibF, sibA, sibDm, sibChirpVal, chirpDk, false);
      }
    }
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const blockSize = out.length;

    this.updateParams(parameters);
    const m = this.m;

    // Step chaos continuously — multiple steps per block for proper traversal
    const chaosSteps = Math.max(1, Math.ceil(m.chaosSpeed * 10));
    for (let i = 0; i < chaosSteps; i++) this.lastChaos = this.stepChaos(m.chaosSpeed);

    if (m.amplitude > 0) {
      const rateModulator = 0.3 + this.lastChaos.x * 1.4;
      const effectiveRate = Math.max(0.01, m.rate * rateModulator);

      const blockDuration = blockSize / this.sr;
      this.nextEvent -= blockDuration;
      while (this.nextEvent <= 0) {
        this.spawnEvent();
        this.lastChaos = this.stepChaos(m.chaosSpeed);
        this.nextEvent += -Math.log(Math.max(1e-10, 1 - this.lastChaos.y)) / effectiveRate;
      }
    }

    const twoPiOverSr = 6.2832 / this.sr;
    const density = m.density;
    const transientLP = 0.5;

    for (let s = 0; s < blockSize; s++) {
      let sum = 0;

      for (let i = 0; i < this.N; i++) {
        if (!this.active[i]) continue;
        let sample = 0;

        if (this.transLeft[i] > 0) {
          const t = 1 - this.transLeft[i] / this.transLen[i];
          const noiseEnv = Math.exp(-5 * t);
          const toneEnv = t;
          const noise = Math.random() * 2 - 1;
          this.transLP[i] = this.transLP[i] * (1 - transientLP) + noise * transientLP;
          const sinSample = Math.sin(this.phase[i]);
          sample = this.amp[i] * (this.transLP[i] * noiseEnv + sinSample * toneEnv);
          this.phase[i] += this.freq[i] * twoPiOverSr;
          this.freq[i] += this.evChirp[i];
          this.evChirp[i] *= this.chirpDecay[i];
          this.transLeft[i]--;
        } else if (this.useRes[i]) {
          const impulse = this.b1[i] > 0 ? 1.0 : 0;
          if (impulse) this.b1[i] = 0;
          const y = this.b0[i] * impulse - this.a1[i] * this.z1[i] - this.a2[i] * this.z2[i];
          this.z2[i] = this.z1[i];
          this.z1[i] = y;
          sample = y * this.amp[i];
        } else {
          sample = this.amp[i] * Math.sin(this.phase[i]);
          this.phase[i] += this.freq[i] * twoPiOverSr;
          this.freq[i] += this.evChirp[i];
          this.evChirp[i] *= this.chirpDecay[i];
          if (this.phase[i] > 6.2832) this.phase[i] -= 6.2832;
        }

        this.amp[i] *= this.decayMul[i];
        if (this.amp[i] < 0.0001) { this.active[i] = 0; continue; }
        sum += sample;
      }

      this.globalLP = this.globalLP * 0.15 + sum * 0.85;
      const shaped = this.globalLP * density;
      this.dcY = shaped - this.dcX + 0.995 * this.dcY;
      this.dcX = shaped;
      out[s] = this.dcY;
    }
    return true;
  }
}

registerProcessor("swarm-processor", SwarmProcessor);
