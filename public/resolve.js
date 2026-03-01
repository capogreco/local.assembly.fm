/**
 * Generator Resolver — resolves generator objects to numbers
 *
 * Each generator param: base * nums[numIdx] / dens[denIdx]
 * Indices are randomized per-client for harmonic differentiation.
 * Commands move indices independently across clients.
 */

// --- Generator state ---

function createGeneratorState() {
  return {};
}

function executeCommand(command, array, currentIdx) {
  switch (command) {
    case "static":
      return currentIdx;
    case "increment":
      return (currentIdx + 1) % array.length;
    case "decrement":
      return (currentIdx - 1 + array.length) % array.length;
    case "random":
      return Math.floor(Math.random() * array.length);
    case "shuffle":
      for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }
      return 0;
    default:
      return currentIdx;
  }
}

function processRangeGenerator(paramName, gen, state) {
  if (!state[paramName]) {
    const t = Math.random();
    const minVal = gen.min !== undefined ? gen.min : 0;
    const maxVal = gen.max !== undefined ? gen.max : 1;
    state[paramName] = {
      type: "range",
      min: minVal,
      max: maxVal,
      value: minVal + t * (maxVal - minVal),
    };
  } else {
    const ps = state[paramName];
    if (gen.min !== undefined) ps.min = gen.min;
    if (gen.max !== undefined) ps.max = gen.max;
    ps.value = Math.max(ps.min, Math.min(ps.max, ps.value));
  }

  const ps = state[paramName];
  if (gen.command) {
    switch (gen.command) {
      case "scatter":
        ps.value = ps.min + Math.random() * (ps.max - ps.min);
        break;
      case "walk": {
        const step = (ps.max - ps.min) * (0.05 + Math.random() * 0.1);
        ps.value += (Math.random() < 0.5 ? -1 : 1) * step;
        ps.value = Math.max(ps.min, Math.min(ps.max, ps.value));
        break;
      }
      case "converge":
        ps.value += ((ps.min + ps.max) / 2 - ps.value) * 0.3;
        break;
    }
  }
  return ps.value;
}

function processGenerator(paramName, gen, state) {
  if (!state[paramName]) {
    // First encounter — initialize arrays and randomize indices
    const nums = gen.nums || [1];
    const dens = gen.dens || [1];
    state[paramName] = {
      base: gen.base !== undefined ? gen.base : 1,
      nums: nums,
      dens: dens,
      numIdx: Math.floor(Math.random() * nums.length),
      denIdx: Math.floor(Math.random() * dens.length),
    };
  } else {
    // Subsequent — update arrays/base if provided
    const ps = state[paramName];
    if (gen.base !== undefined) ps.base = gen.base;
    if (gen.nums !== undefined) {
      ps.nums = gen.nums;
      ps.numIdx = Math.floor(Math.random() * ps.nums.length);
    }
    if (gen.dens !== undefined) {
      ps.dens = gen.dens;
      ps.denIdx = Math.floor(Math.random() * ps.dens.length);
    }
  }

  const ps = state[paramName];

  // Execute commands after reconfiguration
  if (gen.numCommand) {
    ps.numIdx = executeCommand(gen.numCommand, ps.nums, ps.numIdx);
  }
  if (gen.denCommand) {
    ps.denIdx = executeCommand(gen.denCommand, ps.dens, ps.denIdx);
  }

  return ps.base * ps.nums[ps.numIdx] / ps.dens[ps.denIdx];
}

function processMessage(msg, generatorState) {
  const resolved = { type: "params" };

  for (const key of Object.keys(msg)) {
    if (key === "type") continue;
    const val = msg[key];
    if (typeof val === "number") {
      resolved[key] = val;
    } else if (typeof val === "object" && val !== null) {
      if (val.min !== undefined || val.max !== undefined || val.command !== undefined) {
        resolved[key] = processRangeGenerator(key, val, generatorState);
      } else {
        resolved[key] = processGenerator(key, val, generatorState);
      }
    }
  }

  return resolved;
}
