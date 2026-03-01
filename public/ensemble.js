/**
 * Ensemble Client — N synth instances with generator resolver
 *
 * Uses: resolve.js, synth-instance.js, connection.js, scope.js
 * Each instance gets its own seeded generator state (index 0..N-1).
 * Panned L-R, master gain 1/sqrt(N).
 */

const overlay = document.getElementById("overlay");
const connStatus = document.getElementById("conn-status");
const clientCount = document.getElementById("client-count");
const countDisplay = document.getElementById("voice-count");
const btnMinus = document.getElementById("btn-minus");
const btnPlus = document.getElementById("btn-plus");

let audioCtx, masterGain, conn, setOrbit;
let instances = [];
let N = 8;

// Accumulated program state for rebuild (arrays/base + direct values, no commands)
let currentProgram = {};

function storeProgram(msg) {
  for (const key of Object.keys(msg)) {
    if (key === "type") continue;
    const val = msg[key];
    if (typeof val === "number") {
      currentProgram[key] = val;
    } else if (typeof val === "object" && val !== null) {
      if (!currentProgram[key] || typeof currentProgram[key] === "number") {
        currentProgram[key] = {};
      }
      if (val.base !== undefined) currentProgram[key].base = val.base;
      if (val.nums !== undefined) currentProgram[key].nums = [...val.nums];
      if (val.dens !== undefined) currentProgram[key].dens = [...val.dens];
    }
  }
}

function getSetupMessage() {
  const msg = { type: "params" };
  for (const [key, val] of Object.entries(currentProgram)) {
    if (typeof val === "object") {
      msg[key] = { ...val };
    } else {
      msg[key] = val;
    }
  }
  return msg;
}

async function buildInstances() {
  // Disconnect existing
  for (const inst of instances) {
    inst.worklet.disconnect();
    inst.splitter.disconnect();
    if (inst.panner) inst.panner.disconnect();
  }

  instances = [];
  masterGain.gain.value = 1 / Math.sqrt(N);

  for (let i = 0; i < N; i++) {
    const inst = await createSynthInstance(audioCtx);
    const panner = audioCtx.createStereoPanner();
    panner.pan.value = N === 1 ? 0 : -1 + 2 * i / (N - 1);
    inst.splitter.connect(panner, 0);
    panner.connect(masterGain);
    inst.panner = panner;
    inst.genState = createGeneratorState(i);
    instances.push(inst);
  }

  // Re-resolve current program for all new instances
  if (Object.keys(currentProgram).length > 0) {
    const setup = getSetupMessage();
    for (const inst of instances) {
      const resolved = processMessage(setup, inst.genState);
      inst.worklet.port.postMessage(resolved);
    }
  }

  // Reinit scope
  const scopeCanvas = document.getElementById("scope");
  if (scopeCanvas) {
    setOrbit = initScope(scopeCanvas, instances);
  }

  countDisplay.textContent = N;
}

async function handleStart() {
  overlay.classList.add("hidden");
  try {
    audioCtx = new AudioContext();
    await audioCtx.resume();
    await audioCtx.audioWorklet.addModule("processor.js");
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
    await buildInstances();
  } catch (err) {
    console.error("Audio init failed:", err);
    overlay.querySelector("span").textContent = "audio failed: " + err.message;
    overlay.classList.remove("hidden");
    return;
  }

  conn = connect(onMessage, connStatus, clientCount);
}

function onMessage(msg) {
  if (msg.type === "params") {
    storeProgram(msg);
    for (const inst of instances) {
      const resolved = processMessage(msg, inst.genState);
      inst.worklet.port.postMessage(resolved);
    }
    if (setOrbit) {
      const angle = typeof msg.orbitAngle === "number" ? msg.orbitAngle : undefined;
      const thrust = typeof msg.orbitThrust === "number" ? msg.orbitThrust : undefined;
      if (angle !== undefined || thrust !== undefined) setOrbit(angle, thrust);
    }
  }
}

btnMinus.addEventListener("click", () => {
  if (N > 1 && audioCtx) { N--; buildInstances(); }
});

btnPlus.addEventListener("click", () => {
  if (N < 32 && audioCtx) { N++; buildInstances(); }
});

overlay.addEventListener("touchend", (e) => { e.preventDefault(); handleStart(); }, { once: true });
overlay.addEventListener("click", () => handleStart(), { once: true });
