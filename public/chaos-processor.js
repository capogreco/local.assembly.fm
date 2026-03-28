/**
 * Chaos Processor — strange attractor modulation source
 * 3-channel output (x, y, z state variables).
 * Systems: rossler, lorenz, sprott-b through sprott-s, sloth.
 * Speed and character params via AudioParam.
 */

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
    // Random initial conditions — ensures each instance diverges
    this.x = (Math.random() - 0.5) * 0.2;
    this.y = (Math.random() - 0.5) * 0.2;
    this.z = (Math.random() - 0.5) * 0.2;
    // Normalisation bounds (updated dynamically)
    this.maxAbs = 1;
    // Sloth comparator state
    this.qz = 1;
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
        // NLC Sloth ODE (mathematical essence, not circuit model)
        // Comparator nonlinearity creates double-scroll attractor
        const q = z < 0 ? 1 : -1;
        return [
          -(z * 1.0 + q * 0.213 + y * 0.01),
          (x * 0.01 - y * 0.03),
          -(y * 0.01)
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

      // Adaptive normalisation — track max absolute value
      const ax = Math.abs(this.x), ay = Math.abs(this.y), az = Math.abs(this.z);
      const m = Math.max(ax, ay, az);
      if (m > this.maxAbs) this.maxAbs = m;
      // Slow decay so normalisation tracks the attractor bounds
      this.maxAbs *= 0.999999;
      this.maxAbs = Math.max(this.maxAbs, 0.001);

      // Blow-up protection
      if (m > 1e6 || isNaN(m)) {
        this.x = 0.1; this.y = 0; this.z = 0;
        this.maxAbs = 1;
      }

      const scale = 1 / this.maxAbs;
      outX[i] = this.x * scale;
      if (outY) outY[i] = this.y * scale;
      if (outZ) outZ[i] = this.z * scale;
    }

    return true;
  }
}

registerProcessor("chaos-processor", ChaosProcessor);
