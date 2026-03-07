/**
 * Ctrl Client — WebMIDI to WebSocket bridge
 *
 * Manages its own WebSocket (no connection.js dependency).
 * Parses MIDI CC and note messages, sends as { type: "ctrl" } JSON.
 */

const overlay = document.getElementById("overlay");
const mainEl = document.getElementById("main");
const connStatusEl = document.getElementById("conn-status");
const deviceListEl = document.getElementById("device-list");
const activityEl = document.getElementById("activity");
const ccMappedEl = document.getElementById("cc-mapped");
const ccRawEl = document.getElementById("cc-raw");

let ws = null;
let midiAccess = null;
let flashTimeout = null;

// CC mapping display (mirrors server CC_ROUTE)
const CC_MAP = {
  2:  { param: "amplitude",  scale: 0.2 },
  1:  { param: "zingAmount", scale: 1.0 },
  12: { param: "vowelY",     scale: 1.0 },
  13: { param: "vowelX",     scale: 1.0 },
};

// Build mapped CC bars
const ccBars = {};
for (const [cc, info] of Object.entries(CC_MAP)) {
  const row = document.createElement("div");
  row.className = "cc-row";
  row.innerHTML = `<span class="cc-label">cc${cc} ${info.param}</span>` +
    `<div class="cc-bar-bg"><div class="cc-bar" id="bar-${cc}"></div></div>` +
    `<span class="cc-val" id="val-${cc}">0</span>`;
  ccMappedEl.appendChild(row);
  ccBars[cc] = { bar: null, val: null };
}
// Resolve after DOM append
for (const cc of Object.keys(CC_MAP)) {
  ccBars[cc].bar = document.getElementById(`bar-${cc}`);
  ccBars[cc].val = document.getElementById(`val-${cc}`);
}

const MAX_RAW_LINES = 12;

function updateCC(cc, value) {
  if (ccBars[cc]) {
    ccBars[cc].bar.style.width = `${(value * 100).toFixed(1)}%`;
    ccBars[cc].val.textContent = value.toFixed(2);
  }
}

function logRaw(text) {
  const div = document.createElement("div");
  div.textContent = text;
  ccRawEl.insertBefore(div, ccRawEl.firstChild);
  while (ccRawEl.children.length > MAX_RAW_LINES) {
    ccRawEl.removeChild(ccRawEl.lastChild);
  }
}

function handleStart() {
  overlay.classList.add("hidden");
  mainEl.classList.add("active");
  connectWS();
  initMIDI();
}

// --- WebSocket ---

function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}`;

  try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }

  ws.addEventListener("open", () => {
    connStatusEl.textContent = "connected";
    connStatusEl.className = "connected";
  });

  ws.addEventListener("close", () => {
    connStatusEl.textContent = "disconnected";
    connStatusEl.className = "disconnected";
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    ws = null;
  });
}

function scheduleReconnect() {
  setTimeout(() => { if (!ws) connectWS(); }, 2000);
}

function sendCtrl(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// --- Activity flash ---

function flash() {
  activityEl.classList.add("flash");
  if (flashTimeout) clearTimeout(flashTimeout);
  flashTimeout = setTimeout(() => activityEl.classList.remove("flash"), 80);
}

// --- WebMIDI ---

async function initMIDI() {
  try {
    midiAccess = await navigator.requestMIDIAccess();
  } catch (err) {
    deviceListEl.innerHTML = '<div class="device none">midi not available</div>';
    return;
  }

  updateDeviceList();
  bindInputs();

  midiAccess.onstatechange = () => {
    updateDeviceList();
    bindInputs();
  };
}

function updateDeviceList() {
  const inputs = [...midiAccess.inputs.values()];
  if (inputs.length === 0) {
    deviceListEl.innerHTML = '<div class="device none">none</div>';
    return;
  }
  deviceListEl.innerHTML = inputs
    .map(i => `<div class="device">${i.name || i.id}</div>`)
    .join("");
}

function bindInputs() {
  for (const input of midiAccess.inputs.values()) {
    input.onmidimessage = onMIDIMessage;
  }
}

function onMIDIMessage(e) {
  const [status, d1, d2] = e.data;
  const type = status & 0xf0;
  const channel = status & 0x0f;

  flash();

  if (type === 0xb0) {
    // Control Change
    const value = d2 / 127;
    sendCtrl({
      type: "ctrl",
      source: "cc",
      channel,
      cc: d1,
      value,
    });
    updateCC(d1, value);
    logRaw(`cc ${d1} = ${d2} (${value.toFixed(2)})`);
  } else if (type === 0x90) {
    // Note On (velocity 0 = note off)
    const velocity = d2 / 127;
    sendCtrl({
      type: "ctrl",
      source: "note",
      channel,
      note: d1,
      velocity,
    });
    logRaw(`note ${d1} on vel=${d2}`);
  } else if (type === 0x80) {
    // Note Off
    sendCtrl({
      type: "ctrl",
      source: "note",
      channel,
      note: d1,
      velocity: 0,
    });
    logRaw(`note ${d1} off`);
  }
}

// --- Start ---

overlay.addEventListener("touchend", (e) => { e.preventDefault(); handleStart(); }, { once: true });
overlay.addEventListener("click", () => handleStart(), { once: true });
