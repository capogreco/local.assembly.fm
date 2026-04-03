/**
 * Chaos Processor — strange attractor modulation source
 * 3-channel output (x, y, z state variables).
 * Systems: rossler, lorenz, sprott-b through sprott-s, sloth.
 * Speed and character params via AudioParam.
 */

// Per-system known attractor bounds (max absolute value across x,y,z).
// Used for fixed normalisation so output stays in [-1, 1] without
// the jitter caused by adaptive tracking.
const ATTRACTOR_BOUNDS = {
  rossler: 23,     // z spikes to ~22 at c=5.7
  lorenz: 48,      // z reaches ~48 at rho=38
  "sprott-b": 4,
  "sprott-c": 5,
  "sprott-d": 5,
  "sprott-e": 6,
  "sprott-f": 5,
  "sprott-g": 3,
  "sprott-h": 5,
  "sprott-i": 1.1,
  "sprott-j": 28,
  "sprott-k": 4,
  "sprott-l": 37,
  "sprott-m": 6,
  "sprott-n": 28,
  "sprott-o": 2,
  "sprott-p": 2.5,
  "sprott-q": 10,
  "sprott-r": 14,
  "sprott-s": 5,
  jerk: 4,
  sloth: 2,
};

// On-attractor initial conditions for each system, so integration
// starts on the attractor instead of needing transient warm-up.
// These were sampled from converged trajectories.
const ATTRACTOR_ICS = {
  rossler: [-5.0, 3.0, 0.05],
  lorenz: [-6.0, -8.0, 22.0],
  jerk: [0.5, 0.1, -0.1],
  sloth: [0.5, 0.1, -0.3],
};

class ChaosProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "speed", defaultValue: 1, automationRate: "k-rate" },
      { name: "param", defaultValue: 0, automationRate: "k-rate" },
    ];
  }

  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.system = opts.system || "rossler";

    // Start on attractor with jitter + random warm-up (1-2 orbits via Euler)
    const ic = ATTRACTOR_ICS[this.system];
    const jitter = () => (Math.random() - 0.5) * 0.5;
    if (ic) {
      this.x = ic[0] + jitter();
      this.y = ic[1] + jitter();
      this.z = ic[2] + jitter();
    } else {
      this.x = (Math.random() - 0.5) * 2;
      this.y = (Math.random() - 0.5) * 2;
      this.z = (Math.random() - 0.5) * 2;
    }

    this.fixedBound = ATTRACTOR_BOUNDS[this.system] || 0;
    this.maxAbs = this.fixedBound || 1;

    // Random warm-up: advance 1-2 orbits via fast Euler to spread instances
    // across the attractor. ~50k steps is ~1 orbit for most systems at dt=1/sr.
    const warmupSteps = Math.floor(Math.random() * 100000) + 50000;
    const warmupDt = 1 / sampleRate;
    for (let i = 0; i < warmupSteps; i++) {
      const [dx, dy, dz] = this.derivatives(this.x, this.y, this.z, 0);
      this.x += dx * warmupDt;
      this.y += dy * warmupDt;
      this.z += dz * warmupDt;
      // Clamp during warm-up to prevent escape
      const bound = this.fixedBound || 50;
      const m = Math.max(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z));
      if (m > bound * 3 || isNaN(m)) {
        const ric = ATTRACTOR_ICS[this.system];
        if (ric) { this.x = ric[0]; this.y = ric[1]; this.z = ric[2]; }
        else { this.x = 0.1; this.y = 0; this.z = 0; }
      }
    }
  }

  derivatives(x, y, z, p) {
    switch (this.system) {
      case "rossler": {
        const a = 0.2, b = 0.2, c = 5.7 + p * 2;
        return [-(y + z), x + a * y, b + z * (x - c)];
      }
      case "lorenz": {
        const sigma = 10, rho = 28 + p * 10, beta = 8 / 3;
        return [sigma * (y - x), x * (rho - z) - y, x * y - beta * z];
      }
      case "sprott-b": return [y * z, x - y, 1 - x * y];
      case "sprott-c": return [y * z, x - y, 1 - x * x];
      case "sprott-d": return [-y, x + z, x * z + 3 * y * y];
      case "sprott-e": return [y * z, x * x - y, 1 - 4 * x];
      case "sprott-f": return [y + z, -x + 0.5 * y, x * x - z];
      case "sprott-g": return [0.4 * x + z, x * z - y, -x + y];
      case "sprott-h": return [-y + z * z, x + 0.5 * y, x - z];
      case "sprott-i": return [-0.2 * y, x + z, x + y * y - z];
      case "sprott-j": return [2 * z, -2 * y + z, -x + y + y * y];
      case "sprott-k": return [x * y - z, x - y, x + 0.3 * z];
      case "sprott-l": return [y + 3.9 * z, 0.9 * x * x - y, 1 - x];
      case "sprott-m": return [-z, -x * x - y, 1.7 + 1.7 * x + y];
      case "sprott-n": return [-2 * y, x + z * z, 1 + y - 2 * z];
      case "sprott-o": return [y, x - z, x + x * z + 2.7 * y];
      case "sprott-p": return [2.7 * y + z, -x + y * y, x + y];
      case "sprott-q": return [-z, x - y, 3.1 * x + y * y + 0.5 * z];
      case "sprott-r": return [0.9 - y, 0.4 + z, x * y - z];
      case "sprott-s": return [-x - 4 * y, x + z * z, 1 + x];
      case "jerk": {
        // Simplest dissipative chaotic flow: x''' + A*x'' - x'^2 + x = 0
        // State: x=x, y=x', z=x''
        const A = 2.017 + p * 0.1;
        return [y, z, -A * z + y * y - x];
      }
      case "sloth": {
        // NLC Sloth circuit (Andrew Fitch) — exact component-derived coefficients
        // C1=2uF, C2=1.42uF, C3=50uF, R1=1M, R2=4.7M, R6=100k, R7=100k, K=110k
        // dx/dt = -(1/C1)(z/R1 + Vsat/R2 + y/K)
        // dy/dt = (1/C3)(x/R6 - (1/R6+1/K+1/R7)*y)
        // dz/dt = -(1/(R7*C2))*y
        // Comparator: Vsat = +11.38V when z<0, -10.64V when z>=0
        const vsat = z < 0 ? 11.38 : -10.64;
        return [
          -(z * 0.5 + vsat * 0.10638297872340426 + y * 4.545454545454546),
          (x * 0.2 - y * 0.5818181818181818),
          -(y * 7.042253521126761)
        ];
      }
      default: return [0, 0, 0];
    }
  }

  process(_inputs, outputs, parameters) {
    const outX = outputs[0]?.[0];
    const outY = outputs[0]?.[1];
    const outZ = outputs[0]?.[2];
    if (!outX) return true;

    const speed = parameters.speed[0];
    const param = parameters.param[0];
    const dt = speed / sampleRate;
    const blowUpThreshold = (this.fixedBound || 50) * 10;

    for (let i = 0; i < outX.length; i++) {
      // RK4 integration
      const [k1x, k1y, k1z] = this.derivatives(this.x, this.y, this.z, param);
      const [k2x, k2y, k2z] = this.derivatives(
        this.x + k1x * dt * 0.5, this.y + k1y * dt * 0.5, this.z + k1z * dt * 0.5, param);
      const [k3x, k3y, k3z] = this.derivatives(
        this.x + k2x * dt * 0.5, this.y + k2y * dt * 0.5, this.z + k2z * dt * 0.5, param);
      const [k4x, k4y, k4z] = this.derivatives(
        this.x + k3x * dt, this.y + k3y * dt, this.z + k3z * dt, param);

      this.x += (k1x + 2 * k2x + 2 * k3x + k4x) * dt / 6;
      this.y += (k1y + 2 * k2y + 2 * k3y + k4y) * dt / 6;
      this.z += (k1z + 2 * k2z + 2 * k3z + k4z) * dt / 6;

      const ax = Math.abs(this.x), ay = Math.abs(this.y), az = Math.abs(this.z);
      const m = Math.max(ax, ay, az);

      // Blow-up protection — reset to on-attractor point
      if (m > blowUpThreshold || isNaN(m)) {
        const ic = ATTRACTOR_ICS[this.system];
        if (ic) {
          this.x = ic[0]; this.y = ic[1]; this.z = ic[2];
        } else {
          this.x = 0.1; this.y = 0; this.z = 0;
        }
        this.maxAbs = this.fixedBound || 1;
      }

      // Energy-based damping: if trajectory exceeds 2x the expected bound,
      // gently pull it back. This prevents slow divergence in marginal
      // systems (e.g. jerk) without hard-clipping.
      if (this.fixedBound > 0) {
        const ratio = m / this.fixedBound;
        if (ratio > 2) {
          const damping = 2 / ratio;
          this.x *= damping;
          this.y *= damping;
          this.z *= damping;
        }
      }

      // Normalisation: use fixed bounds for known systems, adaptive for others
      let scale;
      if (this.fixedBound > 0) {
        // Fixed bound with a little headroom tracking for param-shifted attractors
        if (m > this.maxAbs) this.maxAbs = m;
        // Very slow decay back toward the known bound
        this.maxAbs += (this.fixedBound - this.maxAbs) * 0.00001;
        this.maxAbs = Math.max(this.maxAbs, this.fixedBound * 0.5);
        scale = 1 / this.maxAbs;
      } else {
        // Adaptive for unknown systems
        if (m > this.maxAbs) this.maxAbs = m;
        this.maxAbs *= 0.999999;
        this.maxAbs = Math.max(this.maxAbs, 0.001);
        scale = 1 / this.maxAbs;
      }

      outX[i] = this.x * scale;
      if (outY) outY[i] = this.y * scale;
      if (outZ) outZ[i] = this.z * scale;
    }

    return true;
  }
}

registerProcessor("chaos-processor", ChaosProcessor);
