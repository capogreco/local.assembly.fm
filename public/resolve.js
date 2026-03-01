/**
 * Generator Resolver — resolves generator objects to numbers
 *
 * Each generator param: base * nums[numIdx] / dens[denIdx]
 * Indices are seeded per-client for harmonic differentiation.
 * Commands move indices independently across clients.
 */

// --- Seeded RNG ---

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function seededIndex(seed, len) {
  return seed % len;
}

function paramSeed(clientId, paramName) {
  return hash(`${clientId}:${paramName}`);
}

// --- Generator state ---

function createGeneratorState(clientId) {
  return { _clientId: clientId };
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

function processGenerator(paramName, gen, state) {
  const clientId = state._clientId;

  if (!state[paramName]) {
    // First encounter — initialize arrays and seed indices
    const nums = gen.nums || [1];
    const dens = gen.dens || [1];
    const seed = paramSeed(clientId, paramName);
    state[paramName] = {
      base: gen.base !== undefined ? gen.base : 1,
      nums: nums,
      dens: dens,
      numIdx: seededIndex(seed, nums.length),
      denIdx: seededIndex(hash(`${seed}:den`), dens.length),
    };
  } else {
    // Subsequent — update arrays/base if provided
    const ps = state[paramName];
    if (gen.base !== undefined) ps.base = gen.base;
    if (gen.nums !== undefined) {
      ps.nums = gen.nums;
      ps.numIdx = ps.numIdx % ps.nums.length;
    }
    if (gen.dens !== undefined) {
      ps.dens = gen.dens;
      ps.denIdx = ps.denIdx % ps.dens.length;
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
      resolved[key] = processGenerator(key, val, generatorState);
    }
  }

  return resolved;
}
