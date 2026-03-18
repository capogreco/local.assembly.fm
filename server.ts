const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";
const HTTPS_PORT = 443;
const HTTP_PORT = 80;
const HOST_IP = Deno.env.get("HOST_IP") || "192.168.178.10";
const HOST_DOMAIN = Deno.env.get("HOST_DOMAIN") || "local.assembly.fm";

// OSC / monome grid constants
const SERIALOSC_PORT = 12002;
const GRID_LISTEN_PORT = 13000;
const GRID_PREFIX = "/assembly";

// --- Status display ---

const status = {
  ctrl: 0,
  synth: 0,
  sse: 0,
  applied: false,
  lastEvent: "",
  lastEventTime: 0,
};

function event(msg: string): void {
  status.lastEvent = msg;
  status.lastEventTime = Date.now();
  // print event above the status line
  Deno.stdout.writeSync(new TextEncoder().encode(`\r\x1b[K  ${msg}\n`));
  drawStatus();
}

function drawStatus(): void {
  const synth = synthWsClients.size;
  const sse = sseClients.size;
  const ctrl = ctrlSockets.size;
  const total = synth + sse;
  const state = status.applied ? "\x1b[32m●\x1b[0m applied" : "\x1b[33m○\x1b[0m idle";
  const clients = total === 0 ? "\x1b[90m0 clients\x1b[0m" : `\x1b[36m${total} client${total !== 1 ? "s" : ""}\x1b[0m`;
  const ctrlLabel = ctrl > 0 ? "\x1b[32mctrl\x1b[0m" : "\x1b[90mctrl\x1b[0m";
  const ws = synth > 0 ? `${synth}ws` : "";
  const sseLabel = sse > 0 ? `${sse}sse` : "";
  const transport = [ws, sseLabel].filter(Boolean).join("+") || "";
  const transportStr = transport ? ` (${transport})` : "";

  const line = `  ${ctrlLabel}  ${clients}${transportStr}  ${state}`;
  Deno.stdout.writeSync(new TextEncoder().encode(`\r\x1b[K${line}`));
}

// --- Import shared box types ---

// deno-lint-ignore no-explicit-any
const boxTypes: any = {};
const boxTypesSrc = await Deno.readTextFile("./public/gpi-types.js");
// Strip the ES module export line so we can evaluate as CJS
const boxTypesCjs = boxTypesSrc.replace(/^export\s+\{[^}]*\};?\s*$/m, "");
const boxTypesModule = new Function("exports", boxTypesCjs);
boxTypesModule(boxTypes);
const { BOX_TYPES, boxTypeName, getBoxPorts, getBoxZone, getBoxDef } = boxTypes;

// --- TLS cert check ---

async function hasCerts(): Promise<boolean> {
  try {
    await Deno.stat(CERT_FILE);
    await Deno.stat(KEY_FILE);
    return true;
  } catch {
    return false;
  }
}

// --- Static file serving ---

function mimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html", js: "application/javascript", css: "text/css",
    json: "application/json", png: "image/png", ico: "image/x-icon",
  };
  return types[ext ?? ""] ?? "application/octet-stream";
}

async function serveFile(path: string): Promise<Response> {
  try {
    const body = await Deno.readFile(`./public${path}`);
    return new Response(body, {
      headers: {
        "content-type": mimeType(path),
        "cache-control": "no-cache, must-revalidate"
      }
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// --- Client tracking ---

let nextClientId = 1;
const synthWsClients = new Map<number, WebSocket>();
type SSESend = (data: Record<string, unknown>) => void;
const sseClients = new Map<number, SSESend>();
const ctrlSockets = new Set<WebSocket>();

function totalSynthClients(): number { return synthWsClients.size + sseClients.size; }

function broadcastSynth(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const [, socket] of synthWsClients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
  for (const [, send] of sseClients) send(msg);
}

function sendToClient(clientId: number, msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  const ws = synthWsClients.get(clientId);
  if (ws?.readyState === WebSocket.OPEN) { ws.send(data); return; }
  const sse = sseClients.get(clientId);
  if (sse) sse(msg);
}

function getSynthClientIds(): number[] {
  return [...synthWsClients.keys(), ...sseClients.keys()];
}

// --- Router state (for one/sweep/fraction targeting) ---

const routerState = new Map<number, { index: number }>();

function handleRouterInlet(routerBoxId: number, inlet: number, value: number): void {
  const box = boxes.get(routerBoxId);
  if (!box) return;
  const routerType = boxTypeName(box.text);

  // for `sweep`: inlet 1 is trigger to advance
  if (inlet === 1 && routerType === "sweep") {
    if (!routerState.has(routerBoxId)) routerState.set(routerBoxId, { index: 0 });
    const state = routerState.get(routerBoxId)!;
    const clients = getSynthClientIds();
    if (clients.length > 0) state.index = (state.index + 1) % clients.length;
    return;
  }

  // all routers — send immediately
  sendViaRouter(routerBoxId, inlet, value);
}

function routerDispatch(routerBoxId: number, msg: Record<string, unknown>, opts: { advanceSweep: boolean; storeLatest: boolean }): void {
  const box = boxes.get(routerBoxId);
  if (!box) return;
  const routerType = boxTypeName(box.text);

  if (opts.storeLatest) {
    latestValues.set(routerBoxId + ":" + (msg.ch || 0), JSON.stringify(msg));
  }

  const clients = getSynthClientIds();
  if (clients.length === 0) return;

  switch (routerType) {
    case "all":
      broadcastSynth(msg);
      break;
    case "one": {
      if (!routerState.has(routerBoxId)) routerState.set(routerBoxId, { index: 0 });
      const state = routerState.get(routerBoxId)!;
      sendToClient(clients[state.index % clients.length], msg);
      state.index = (state.index + 1) % clients.length;
      break;
    }
    case "sweep": {
      if (!routerState.has(routerBoxId)) routerState.set(routerBoxId, { index: 0 });
      const state = routerState.get(routerBoxId)!;
      sendToClient(clients[state.index % clients.length], msg);
      if (opts.advanceSweep) state.index = (state.index + 1) % clients.length;
      break;
    }
    case "fraction": {
      const frac = parseFloat(box.text.split(/\s+/)[1]) || 0.5;
      for (const id of clients) if (Math.random() < frac) sendToClient(id, msg);
      break;
    }
    default:
      broadcastSynth(msg);
  }
}

function sendViaRouter(routerBoxId: number, channel: number, value: number): void {
  const msg = { type: "rv", r: routerBoxId, ch: channel, v: value } as Record<string, unknown>;
  routerDispatch(routerBoxId, msg, { advanceSweep: true, storeLatest: true });
}

function sendCommandViaRouter(routerBoxId: number, channel: number, msg: Record<string, unknown>): void {
  routerDispatch(routerBoxId, { ...msg, r: routerBoxId, ch: channel }, { advanceSweep: false, storeLatest: false });
}

// Trace from a box outlet to find all routers it eventually reaches
function traceToRouters(boxId: number, outletIndex: number): Array<{routerId: number, channel: number}> {
  const results: Array<{routerId: number, channel: number}> = [];
  const visited = new Set<string>();

  function trace(bid: number, oi: number): void {
    const key = bid + ":" + oi;
    if (visited.has(key)) return;
    visited.add(key);

    for (const cable of cablesFromOutlet(bid, oi)) {
      const dst = boxes.get(cable.dstBox);
      if (!dst) continue;
      const def = getBoxDef(dst.text);
      if (!def) continue;
      if (def.zone === "router") {
        results.push({ routerId: cable.dstBox, channel: cable.dstInlet });
      } else if (def.zone !== "synth") {
        // trace through ctrl-side boxes to find routers beyond them
        const outlets = def.outlets?.length || 1;
        for (let i = 0; i < outlets; i++) trace(cable.dstBox, i);
      }
    }
  }

  trace(boxId, outletIndex);
  return results;
}

// Send an envelope/slew command through all routers reachable from a box's outlet
function sendEnvCommand(boxId: number, outletIndex: number, msg: Record<string, unknown>): void {
  for (const { routerId, channel } of traceToRouters(boxId, outletIndex)) {
    sendCommandViaRouter(routerId, channel, msg);
  }
}

function sendCtrl(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const socket of ctrlSockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

function broadcastClientCount(): void {
  const count = totalSynthClients();
  console.log(`  client count: ${count} (ws:${synthWsClients.size} sse:${sseClients.size})`);
  broadcastSynth({ type: "count", clients: count });
  sendCtrl({ type: "count", clients: count });
}

// --- IP auth tracking ---

const authenticatedIPs = new Set<string>();
const ipConnections = new Map<string, Set<number>>();
const deauthTimers = new Map<string, number>();

function trackConnect(clientIP: string, id: number): void {
  if (!ipConnections.has(clientIP)) ipConnections.set(clientIP, new Set());
  ipConnections.get(clientIP)!.add(id);
  const timer = deauthTimers.get(clientIP);
  if (timer !== undefined) { clearTimeout(timer); deauthTimers.delete(clientIP); }
}

function trackDisconnect(clientIP: string, id: number): void {
  const conns = ipConnections.get(clientIP);
  if (!conns?.has(id)) return;
  conns.delete(id);
  if (conns.size === 0) {
    ipConnections.delete(clientIP);
    if (!deauthTimers.has(clientIP)) {
      const timer = setTimeout(() => {
        authenticatedIPs.delete(clientIP);
        deauthTimers.delete(clientIP);
      }, 5000);
      deauthTimers.set(clientIP, timer);
    }
  }
}

// ============================================================
// --- OSC / Monome Grid Support ---
// ============================================================

// Grid state
let gridSocket: Deno.DatagramConn | null = null;
let gridDevicePort: number | null = null;
const gridDeviceHost = "127.0.0.1";
let gridDeviceInfo: { deviceType: string; deviceId: string } | null = null;

// OSC message encoding
function oscString(s: string): Uint8Array {
  const nullTerm = new TextEncoder().encode(s + "\0");
  const padLen = Math.ceil(nullTerm.length / 4) * 4;
  const padded = new Uint8Array(padLen);
  padded.set(nullTerm);
  return padded;
}

function oscInt(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, n, false);
  return buf;
}

function oscMessage(address: string, typeTags: string, ...args: (string | number)[]): Uint8Array {
  const parts: Uint8Array[] = [oscString(address), oscString("," + typeTags)];
  for (let i = 0; i < args.length; i++) {
    if (typeTags[i] === "s") parts.push(oscString(args[i] as string));
    else if (typeTags[i] === "i") parts.push(oscInt(args[i] as number));
  }
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { result.set(p, offset); offset += p.length; }
  return result;
}

// OSC message parsing
function parseOsc(data: Uint8Array): { address: string; args: (string | number)[] } | null {
  let offset = 0;

  // Read address
  const addressEnd = data.indexOf(0, offset);
  if (addressEnd === -1) return null;
  const address = new TextDecoder().decode(data.slice(offset, addressEnd));
  offset = Math.ceil((addressEnd + 1) / 4) * 4;

  // Read type tag string
  if (offset >= data.length) return null;
  const typeTagEnd = data.indexOf(0, offset);
  if (typeTagEnd === -1) return null;
  const typeTags = new TextDecoder().decode(data.slice(offset + 1, typeTagEnd)); // skip leading ','
  offset = Math.ceil((typeTagEnd + 1) / 4) * 4;

  // Read arguments
  const args: (string | number)[] = [];
  for (const tag of typeTags) {
    if (tag === "s") {
      const strEnd = data.indexOf(0, offset);
      if (strEnd === -1) return null;
      args.push(new TextDecoder().decode(data.slice(offset, strEnd)));
      offset = Math.ceil((strEnd + 1) / 4) * 4;
    } else if (tag === "i") {
      if (offset + 4 > data.length) return null;
      args.push(new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, false));
      offset += 4;
    }
  }

  return { address, args };
}

// Grid communication (with prefix for LED/key messages)
function gridSend(address: string, typeTags: string, ...args: (string | number)[]): void {
  if (!gridSocket || gridDevicePort === null) {
    event(`gridSend failed: socket=${!!gridSocket} port=${gridDevicePort}`);
    return;
  }
  event(`gridSend → port ${gridDevicePort}: ${GRID_PREFIX}${address} [${args.join(", ")}]`);
  const msg = oscMessage(GRID_PREFIX + address, typeTags, ...args);
  gridSocket.send(msg, { transport: "udp", hostname: gridDeviceHost, port: gridDevicePort });
}

// Grid system messages (NO prefix - for /sys/* configuration)
function gridSysSend(address: string, typeTags: string, ...args: (string | number)[]): void {
  if (!gridSocket || gridDevicePort === null) {
    event(`gridSysSend failed: socket=${!!gridSocket} port=${gridDevicePort}`);
    return;
  }
  event(`gridSysSend → port ${gridDevicePort}: ${address} [${args.join(", ")}]`);
  const msg = oscMessage(address, typeTags, ...args);
  gridSocket.send(msg, { transport: "udp", hostname: gridDeviceHost, port: gridDevicePort });
}

function gridLed(x: number, y: number, level: number): void {
  gridSend("/grid/led/level/set", "iii", x, y, level);
}

// Grid region state tracking
interface GridRegion {
  boxId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: "grid-trig" | "grid-toggle" | "grid-array";
}

interface GridArrayState {
  array: number[];           // Current array contents (1-indexed values)
  heldButtons: Set<number>;  // Currently held button x-coordinates (for range gestures)
  rangeGestureActive: boolean; // Track if a range gesture is in progress
}

const gridRegions = new Map<number, GridRegion>();  // boxId → region definition
const gridToggleStates = new Map<number, boolean>(); // boxId → toggle state (for grid-toggle)
const gridArrayStates = new Map<number, GridArrayState>(); // boxId → array state (for grid-array)

// Arc encoder state tracking
interface ArcEncoder {
  boxId: number;
  encoder: number;  // 0-3 for arc 4
  mode: number;     // 0 = continuous rotation (0-1)
}

const arcEncoders = new Map<number, ArcEncoder>();  // boxId → encoder definition
const arcValues = new Map<number, number>();  // boxId → current value (0-1)

// Arc OSC connection (via serialosc, separate from grid)
let arcReady = false;
let arcDevicePort: number | null = null;
let arcDeviceInfo: { deviceType: string; deviceId: string } | null = null;
const ARC_PREFIX = "/assembly";
const ARC_SENSITIVITY = 0.0003;  // Fine-tuned for precise control

// Find which grid region (if any) contains the given button coordinate
function findGridRegion(x: number, y: number): GridRegion | null {
  for (const region of gridRegions.values()) {
    if (x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h) {
      return region;
    }
  }
  return null;
}

// Build grid region and arc encoder registry from current patch boxes
function rebuildGridRegions(): void {
  gridRegions.clear();
  arcEncoders.clear();

  for (const [boxId, box] of boxes) {
    const type = boxTypeName(box.text);

    // Grid regions
    if (type === "grid-trig" || type === "grid-toggle" || type === "grid-array") {
      const args = box.text.split(/\s+/).slice(1).map(Number);
      if (args.length >= 4) {
        gridRegions.set(boxId, {
          boxId,
          x: args[0],
          y: args[1],
          w: args[2],
          h: args[3],
          type: type as "grid-trig" | "grid-toggle" | "grid-array",
        });
        event(`registered ${type} region: box ${boxId} at (${args[0]},${args[1]}) size ${args[2]}×${args[3]}`);
        // Initialize state for new regions
        if (type === "grid-toggle" && !gridToggleStates.has(boxId)) {
          gridToggleStates.set(boxId, false);
        }
        if (type === "grid-array" && !gridArrayStates.has(boxId)) {
          gridArrayStates.set(boxId, { array: [], heldButtons: new Set(), rangeGestureActive: false });
        }
      }
    }

    // Arc encoders
    if (type === "arc") {
      const args = box.text.split(/\s+/).slice(1).map(Number);
      if (args.length >= 2) {
        const encoder = args[0];
        const mode = args[1];
        arcEncoders.set(boxId, { boxId, encoder, mode });
        event(`registered arc encoder: box ${boxId} enc ${encoder} mode ${mode}`);
        // Initialize value if not present
        if (!arcValues.has(boxId)) {
          arcValues.set(boxId, 0.5);
          setBoxValueAndNotify(boxId, 0.5);
        }
      }
    }
  }

  // Render all arc encoders after registration
  if (arcReady) {
    renderAllArcEncoders();
  }
}

// Grid key press handler
function handleGridKey(x: number, y: number, pressed: boolean): void {
  const region = findGridRegion(x, y);
  if (!region) {
    event(`grid key (${x},${y}): no region found`);
    return;
  }

  event(`grid key (${x},${y}) ${pressed ? "down" : "up"} → ${region.type} box ${region.boxId}`);

  if (region.type === "grid-trig") {
    handleGridTrig(region, pressed);
  } else if (region.type === "grid-toggle") {
    handleGridToggle(region, x, y, pressed);
  } else if (region.type === "grid-array") {
    handleGridArray(region, x, y, pressed);
  }
}

// grid-trig: outputs 1 on press, 0 on release
function handleGridTrig(region: GridRegion, pressed: boolean): void {
  setBoxValueAndNotify(region.boxId, pressed ? 1 : 0);
  renderGridRegion(region);
}

// grid-toggle: press to flip between 0 and 1
function handleGridToggle(region: GridRegion, x: number, y: number, pressed: boolean): void {
  if (!pressed) return; // Only react to press, not release

  const currentState = gridToggleStates.get(region.boxId) || false;
  const newState = !currentState;
  gridToggleStates.set(region.boxId, newState);
  setBoxValueAndNotify(region.boxId, newState ? 1 : 0);
  renderGridRegion(region);
}

// grid-array: toggle values, hold+press for range fill/clear
function handleGridArray(region: GridRegion, x: number, y: number, pressed: boolean): void {
  const state = gridArrayStates.get(region.boxId);
  if (!state) return;

  const relativeX = x - region.x;
  const value = relativeX + 1; // Convert to 1-indexed value

  if (pressed) {
    event(`grid-array: press value=${value}, heldButtons=[${Array.from(state.heldButtons).join(",")}], array=[${state.array.join(",")}]`);

    // Check if another button is already held (range gesture)
    if (state.heldButtons.size > 0) {
      // Range gesture: fill or clear based on FIRST button's state
      state.rangeGestureActive = true;
      const firstX = Array.from(state.heldButtons)[0];
      const firstValue = firstX + 1;
      const firstActive = state.array.includes(firstValue);

      const minVal = Math.min(value, firstValue);
      const maxVal = Math.max(value, firstValue);

      if (firstActive) {
        // Clear range: remove all values between min and max (inclusive)
        event(`grid-array: CLEAR range [${minVal}..${maxVal}]`);
        for (let v = minVal; v <= maxVal; v++) {
          const idx = state.array.indexOf(v);
          if (idx !== -1) state.array.splice(idx, 1);
        }
      } else {
        // Fill range: add all values between min and max (inclusive)
        event(`grid-array: FILL range [${minVal}..${maxVal}]`);
        for (let v = minVal; v <= maxVal; v++) {
          if (!state.array.includes(v)) state.array.push(v);
        }
      }
      state.array.sort((a, b) => a - b);
      setBoxValueAndNotify(region.boxId, state.array);
    }

    state.heldButtons.add(relativeX);
  } else {
    // Release
    state.heldButtons.delete(relativeX);

    // Only do single toggle if no range gesture occurred and all buttons are released
    if (state.heldButtons.size === 0) {
      if (!state.rangeGestureActive) {
        event(`grid-array: single toggle value=${value}`);
        const idx = state.array.indexOf(value);
        if (idx !== -1) {
          state.array.splice(idx, 1);
        } else {
          state.array.push(value);
          state.array.sort((a, b) => a - b);
        }
        setBoxValueAndNotify(region.boxId, state.array);
      }
      // Reset range gesture flag when all buttons released
      state.rangeGestureActive = false;
    }
  }

  renderGridRegion(region);
}

// Render LED feedback for a grid region
function renderGridRegion(region: GridRegion): void {
  if (region.type === "grid-trig") {
    // Light up entire region when pressed
    const value = boxValues.get(region.boxId) || 0;
    const level = value > 0 ? 15 : 0;
    event(`grid-trig LED: region (${region.x},${region.y}) level=${level}`);
    for (let dy = 0; dy < region.h; dy++) {
      for (let dx = 0; dx < region.w; dx++) {
        gridLed(region.x + dx, region.y + dy, level);
      }
    }
  } else if (region.type === "grid-toggle") {
    // Light up entire region if toggle is on
    const state = gridToggleStates.get(region.boxId) || false;
    const level = state ? 15 : 0;  // Bright when on, off when off
    for (let dy = 0; dy < region.h; dy++) {
      for (let dx = 0; dx < region.w; dx++) {
        gridLed(region.x + dx, region.y + dy, level);
      }
    }
  } else if (region.type === "grid-array") {
    // Bright for active values, dim for inactive
    const state = gridArrayStates.get(region.boxId);
    if (!state) return;
    for (let dx = 0; dx < region.w; dx++) {
      const value = dx + 1;
      const active = state.array.includes(value);
      const level = active ? 15 : 4;
      for (let dy = 0; dy < region.h; dy++) {
        gridLed(region.x + dx, region.y + dy, level);
      }
    }
  }
}

// serialosc initialization and device discovery
async function initGrid(): Promise<void> {
  try {
    // Create UDP socket for grid communication
    gridSocket = Deno.listenDatagram({ port: GRID_LISTEN_PORT, transport: "udp", hostname: "127.0.0.1" });
    event(`grid listener on port ${GRID_LISTEN_PORT}`);

    // Subscribe to serialosc notifications (for hot-plug detection)
    const notifyMsg = oscMessage("/serialosc/notify", "si", "127.0.0.1", GRID_LISTEN_PORT);
    const notifyConn = Deno.listenDatagram({ port: 0, transport: "udp", hostname: "127.0.0.1" });
    await notifyConn.send(notifyMsg, { transport: "udp", hostname: "127.0.0.1", port: SERIALOSC_PORT });
    notifyConn.close();

    // Send discovery message to serialosc (for devices already connected)
    const discoveryMsg = oscMessage("/serialosc/list", "si", "127.0.0.1", GRID_LISTEN_PORT);
    const serialoscConn = Deno.listenDatagram({ port: 0, transport: "udp", hostname: "127.0.0.1" });
    await serialoscConn.send(discoveryMsg, { transport: "udp", hostname: "127.0.0.1", port: SERIALOSC_PORT });
    serialoscConn.close();

    // Listen for responses
    (async () => {
      for await (const [data, _addr] of gridSocket!) {
        const msg = parseOsc(new Uint8Array(data));
        if (!msg) {
          event(`grid OSC: failed to parse message`);
          continue;
        }

        // Debug: log incoming OSC (skip config echoes)
        if (!["/sys/port", "/sys/host", "/sys/prefix"].includes(msg.address)) {
          event(`grid OSC: ${msg.address} [${msg.args.join(", ")}]`);
        }

        // Device announcement (from /serialosc/list or /serialosc/add)
        if (msg.address === "/serialosc/device" || msg.address === "/serialosc/add") {
          const [deviceId, deviceType, devicePort] = msg.args;
          const devTypeStr = deviceType as string;
          const devPortNum = devicePort as number;
          const devIdStr = deviceId as string;

          // Check if it's an arc or grid — skip if already known
          if (devTypeStr.includes("arc")) {
            if (arcDeviceInfo && arcDeviceInfo.deviceId === devIdStr) continue;
            event(`arc detected: ${devTypeStr} (${devIdStr}) on port ${devPortNum}`);
            arcDevicePort = devPortNum;
            arcDeviceInfo = { deviceType: devTypeStr, deviceId: devIdStr };

            // Configure arc device
            arcSysSend("/sys/port", "i", GRID_LISTEN_PORT);
            arcSysSend("/sys/host", "s", "127.0.0.1");
            arcSysSend("/sys/prefix", "s", ARC_PREFIX);

            // Clear all rings
            for (let i = 0; i < 4; i++) {
              arcSend("/ring/all", "ii", i, 0);
            }

            arcReady = true;

            // Render all active arc encoders
            renderAllArcEncoders();

            // Notify ctrl clients
            sendCtrl({ type: "arc-connected", deviceType: devTypeStr, deviceId: devIdStr });
          } else {
            if (gridDeviceInfo && gridDeviceInfo.deviceId === devIdStr) continue;
            event(`grid detected: ${devTypeStr} (${devIdStr}) on port ${devPortNum}`);
            gridDevicePort = devPortNum;
            gridDeviceInfo = { deviceType: devTypeStr, deviceId: devIdStr };

            // Configure device
            gridSysSend("/sys/port", "i", GRID_LISTEN_PORT);
            gridSysSend("/sys/host", "s", "127.0.0.1");
            gridSysSend("/sys/prefix", "s", GRID_PREFIX);
            gridSend("/grid/led/all", "i", 0); // clear grid

            // Render all active grid regions
            for (const region of gridRegions.values()) {
              renderGridRegion(region);
            }

            // Notify ctrl clients
            sendCtrl({ type: "grid-connected", deviceType: gridDeviceInfo.deviceType, deviceId: gridDeviceInfo.deviceId });
          }
        }

        // Device removed (via serialosc) - happens after /sys/disconnect
        if (msg.address === "/serialosc/remove") {
          const [deviceId, deviceType, devicePort] = msg.args;
          const devTypeStr = deviceType as string;

          if (devTypeStr.includes("arc")) {
            if (arcDeviceInfo) {
              event(`arc removed: ${devTypeStr} (${deviceId})`);
              sendCtrl({ type: "arc-disconnected", deviceType: devTypeStr, deviceId: deviceId as string });
              arcDeviceInfo = null;
              arcReady = false;
            }
          } else {
            if (gridDeviceInfo) {
              event(`grid removed: ${devTypeStr} (${deviceId})`);
              sendCtrl({ type: "grid-disconnected", deviceType: devTypeStr, deviceId: deviceId as string });
              gridDeviceInfo = null;
            }
          }
        }

        // Device disconnected — /sys/disconnect doesn't identify which device.
        // We rely on /serialosc/remove (above) to clear the correct device.
        // Just trigger rediscovery.
        if (msg.address === "/sys/disconnect") {
          event("device disconnected, will rediscover via /serialosc/remove");
        }

        // Device reconnected (sent by device when plugged back in)
        if (msg.address === "/sys/connect") {
          // Query serialosc if we don't have device info
          if (gridDeviceInfo === null || arcDeviceInfo === null) {
            event(`device reconnecting, querying serialosc...`);
            const discoveryMsg = oscMessage("/serialosc/list", "si", "127.0.0.1", GRID_LISTEN_PORT);
            const serialoscConn = Deno.listenDatagram({ port: 0, transport: "udp", hostname: "127.0.0.1" });
            await serialoscConn.send(discoveryMsg, { transport: "udp", hostname: "127.0.0.1", port: SERIALOSC_PORT });
            serialoscConn.close();
          }
        }

        // Grid key press
        if (msg.address === GRID_PREFIX + "/grid/key") {
          const [x, y, state] = msg.args as number[];
          handleGridKey(x, y, state === 1);
        }

        // Arc encoder delta
        if (msg.address === ARC_PREFIX + "/enc/delta") {
          const [encoder, delta] = msg.args as number[];
          event(`arc enc ${encoder} delta ${delta}`);
          handleArcDelta(encoder, delta);
        }
      }
    })();
  } catch (e) {
    console.error("Failed to init grid:", e);
  }
}

// ============================================================
// --- Arc Support (via serialosc OSC) ---
// ============================================================

// Send OSC message to arc device
function arcSend(address: string, typeTag: string, ...args: (string | number)[]): void {
  if (!gridSocket || arcDevicePort === null) return;
  const msg = oscMessage(ARC_PREFIX + address, typeTag, ...args);
  gridSocket.send(msg, { transport: "udp", hostname: "127.0.0.1", port: arcDevicePort });
  event(`arcSend → port ${arcDevicePort}: ${address} [${args.join(", ")}]`);
}

// Send OSC system message to arc device
function arcSysSend(address: string, typeTag: string, ...args: (string | number)[]): void {
  if (!gridSocket || arcDevicePort === null) return;
  const msg = oscMessage(address, typeTag, ...args);
  gridSocket.send(msg, { transport: "udp", hostname: "127.0.0.1", port: arcDevicePort });
  event(`arcSysSend → port ${arcDevicePort}: ${address} [${args.join(", ")}]`);
}

function handleArcDelta(encoder: number, delta: number): void {
  if (encoder < 0 || encoder > 3) return;

  // Find all arc boxes using this encoder
  for (const [boxId, arcEnc] of arcEncoders.entries()) {
    if (arcEnc.encoder === encoder) {
      const currentValue = arcValues.get(boxId) ?? 0.5;  // Use ?? instead of || to handle 0 correctly
      const newValue = Math.max(0, Math.min(1, currentValue + delta * ARC_SENSITIVITY));
      arcValues.set(boxId, newValue);
      setBoxValueAndNotify(boxId, newValue);
      renderArcEncoder(encoder);
    }
  }
}

function renderArcEncoder(encoder: number): void {
  if (arcDevicePort === null) return;

  // Find first box using this encoder to get its value
  for (const [boxId, arcEnc] of arcEncoders.entries()) {
    if (arcEnc.encoder === encoder) {
      const value = arcValues.get(boxId) ?? 0.5;  // Use ?? instead of || to handle 0 correctly

      // Render LED ring as a filled arc from 6 o'clock (bottom)
      // Arc has 64 LEDs per ring (0-63), with LED 0 at top (12 o'clock)
      // LED 32 is at bottom (6 o'clock)
      const numLeds = Math.floor(value * 64);
      const ledData: number[] = new Array(64).fill(0);

      // Fill LEDs from 6 o'clock (LED 32) clockwise
      for (let i = 0; i < numLeds; i++) {
        const ledIndex = (32 + i) % 64;
        ledData[ledIndex] = 15; // Full brightness
      }

      // Send /ring/map message with all 64 LED values
      const typeTags = "i" + "i".repeat(64);
      arcSend("/ring/map", typeTags, encoder, ...ledData);
      return;
    }
  }
}

function renderAllArcEncoders(): void {
  const encodersRendered = new Set<number>();
  for (const arcEnc of arcEncoders.values()) {
    if (!encodersRendered.has(arcEnc.encoder)) {
      renderArcEncoder(arcEnc.encoder);
      encodersRendered.add(arcEnc.encoder);
    }
  }
}

// ============================================================
// --- Patch State (server is the single source of truth) ---
// ============================================================

interface Box {
  x: number; y: number; text: string; inlets: number; outlets: number;
}
interface Cable {
  srcBox: number; srcOutlet: number; dstBox: number; dstInlet: number;
}

const boxes = new Map<number, Box>();
const cables = new Map<number, Cable>();
const boxValues = new Map<number, number>();
const inletValues = new Map<number, number[]>();
// deno-lint-ignore no-explicit-any
const boxState = new Map<number, any>(); // per-box state for time-based boxes
let patchNextId = 1;
let synthBorderY = 400;

// deno-lint-ignore no-explicit-any
let deployedPatch: Record<string, any> | null = null;
const latestValues = new Map<string, string>();

// --- Evaluation engine ---

function isSynthZone(_px: number, py: number): boolean { return py >= synthBorderY; }

function cablesFromOutlet(boxId: number, outlet: number): Cable[] {
  const r: Cable[] = [];
  for (const [, c] of cables) if (c.srcBox === boxId && c.srcOutlet === outlet) r.push(c);
  return r;
}

function evaluateBox(box: Box, iv: number[]): number {
  const name = boxTypeName(box.text);
  const args = box.text.split(/\s+/).slice(1);
  const a = iv[0] || 0;
  const b = iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 0;
  switch (name) {
    case "+": return a + b; case "-": return a - b; case "*": return a * b;
    case "/": return b !== 0 ? a / b : 0; case "%": return b !== 0 ? a % b : 0; case "**": return Math.pow(a, b);
    case "scale": { const mn = parseFloat(args[0]) || 0, mx = parseFloat(args[1]) || 1; return a * (mx - mn) + mn; }
    case "clip": { const mn = parseFloat(args[0]) || 0, mx = parseFloat(args[1]) || 1; return Math.max(mn, Math.min(mx, a)); }
    case "pow": return Math.pow(a, b);
    case "mtof": return 440 * Math.pow(2, (a - 69) / 12);
    case "const": return parseFloat(args[0]) || 0;
    case "gate": return (iv[1] || 0) > 0 ? a : 0;
    case "quantize": { const d = parseFloat(args[0]) || 12; return Math.round(a * d) / d; }
    case "sine": return Math.sin(a * Math.PI * 2) * 0.5 + 0.5;
    case "tri": { const yaw = parseFloat(args[0]) || 0.5; return a < yaw ? (yaw > 0 ? a / yaw : 0) : (yaw < 1 ? (1 - a) / (1 - yaw) : 0); }
    case "sample-hold": return a; // passthrough — actual hold logic is stateful
    default: return a;
  }
}

// --- Batched value updates to ctrl at ~30fps ---

let pendingValueUpdates = new Map<number, number>();

function queueValueUpdate(id: number, value: number): void {
  pendingValueUpdates.set(id, value);
}

setInterval(() => {
  if (pendingValueUpdates.size === 0) return;
  const updates: Array<{ id: number; value: number }> = [];
  for (const [id, value] of pendingValueUpdates) updates.push({ id, value });
  pendingValueUpdates = new Map();
  sendCtrl({ type: "values", updates });
}, 33);

const ONSET_THRESHOLD = 0.01;

function setBoxValueAndNotify(boxId: number, value: number): void {
  const prev = boxValues.get(boxId) ?? 0;
  boxValues.set(boxId, value);
  queueValueUpdate(boxId, value);
  const box = boxes.get(boxId);
  if (!box) return;
  const name = boxTypeName(box.text);
  const def = getBoxDef(box.text);
  if (!def) return;

  // breath/bite: outlet 0 = value, outlet 1 = onset event, outlet 2 = offset event
  if (name === "breath" || name === "bite") {
    propagateAndNotify(boxId, 0, value);
    if (prev < ONSET_THRESHOLD && value >= ONSET_THRESHOLD) propagateAndNotify(boxId, 1, 1);
    if (prev >= ONSET_THRESHOLD && value < ONSET_THRESHOLD) propagateAndNotify(boxId, 2, 0);
    return;
  }

  const outlets = def.outlets.length || 1;
  for (let i = 0; i < outlets; i++) propagateAndNotify(boxId, i, value);
}

function propagateAndNotify(boxId: number, outletIndex: number, value: number): void {
  // Two-phase propagation: deliver all values first, then fire deferred events.
  // This guarantees values arrive at inlets before triggers fire,
  // regardless of cable creation order.
  const deferred: Array<() => void> = [];

  for (const cable of cablesFromOutlet(boxId, outletIndex)) {
    const dst = boxes.get(cable.dstBox);
    if (!dst) continue;
    const def = getBoxDef(dst.text);
    if (!def) continue;
    if (def.zone === "router") {
      const inletDef = def.inlets[cable.dstInlet];
      if (inletDef && inletDef.type === "event") {
        deferred.push(() => handleRouterInlet(cable.dstBox, cable.dstInlet, value));
      } else {
        handleRouterInlet(cable.dstBox, cable.dstInlet, value);
      }
    } else if (def.zone === "synth" && !isSynthZone(dst.x, dst.y)) {
      // above-border engine — send param to ctrl client for local playback
      const paramName = def.inlets[cable.dstInlet]?.name;
      if (paramName) {
        sendCtrl({ type: "engine-param", boxId: cable.dstBox, engineType: boxTypeName(dst.text), param: paramName, value });
      }
    } else if (def.zone !== "synth" && !(def.zone === "any" && isSynthZone(dst.x, dst.y))) {
      const inletDef = def.inlets[cable.dstInlet];
      if (inletDef && inletDef.type === "event" && boxState.has(cable.dstBox)) {
        deferred.push(() => handleEventBox(cable.dstBox, value));
      } else if (handleStatefulInlet(cable.dstBox, cable.dstInlet, value)) {
        // handled by stateful box (phasor, etc.)
      } else {
        let iv = inletValues.get(cable.dstBox);
        if (!iv) { iv = []; inletValues.set(cable.dstBox, iv); }
        iv[cable.dstInlet] = value;
        const result = evaluateBox(dst, iv);
        boxValues.set(cable.dstBox, result);
        queueValueUpdate(cable.dstBox, result);
        const outlets = def.outlets?.length || 1;
        for (let i = 0; i < outlets; i++) propagateAndNotify(cable.dstBox, i, result);
      }
    }
  }

  // Phase 2: fire all deferred events after values have been delivered
  for (const fn of deferred) fn();
}

function isCtrlSide(box: Box): boolean {
  const zone = getBoxZone(box.text);
  return zone === "ctrl" || zone === "router" || (zone === "any" && !isSynthZone(box.x, box.y));
}

function evaluateAllConsts(): void {
  for (const [id, box] of boxes) {
    if (boxTypeName(box.text) === "const" && isCtrlSide(box)) {
      setBoxValueAndNotify(id, parseFloat(box.text.split(/\s+/)[1]) || 0);
    }
  }
}

// --- Time-based box tick ---

function expandIntegerNotation(s: string): number[] {
  const result: number[] = [];
  for (const token of s.split(",")) {
    const m = token.match(/^(-?\d+)-(-?\d+)$/);
    if (m) {
      const a = parseInt(m[1]), b = parseInt(m[2]);
      const step = a <= b ? 1 : -1;
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) result.push(i);
    } else {
      result.push(Number(token));
    }
  }
  return result;
}

// deno-lint-ignore no-explicit-any
function advanceSig(state: any): number {
  switch (state.behaviour) {
    case "shuffle":
      for (let i = state.values.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.values[i], state.values[j]] = [state.values[j], state.values[i]];
      }
      state.index = 0;
      break;
    case "asc":
      state.index = (state.index + 1) % state.values.length;
      break;
    case "desc":
      state.index = (state.index - 1 + state.values.length) % state.values.length;
      break;
    case "random":
      state.index = Math.floor(Math.random() * state.values.length);
      break;
  }
  return state.values[state.index];
}

function initBoxState(id: number, box: Box): void {
  const name = boxTypeName(box.text);
  const args = box.text.split(/\s+/).slice(1);
  switch (name) {
    case "phasor": {
      const loop = args[1] !== "once";
      boxState.set(id, { phase: 0, period: parseFloat(args[0]) || 1, paused: false, loop });
      break;
    }
    case "metro":
      boxState.set(id, { elapsed: 0, interval: parseFloat(args[0]) || 1, paused: false });
      break;
    case "toggle":
      boxState.set(id, { value: 0 });
      break;
    case "sequence":
      boxState.set(id, { index: 0, values: (args[0] || "0").split(",").map(Number) });
      break;
    case "counter":
      boxState.set(id, { count: parseFloat(args[0]) || 0, min: parseFloat(args[0]) || 0, max: parseFloat(args[1]) || 7 });
      break;
    case "drunk":
      boxState.set(id, { value: Math.random(), step: parseFloat(args[0]) || 0.01 });
      break;
    case "ar":
      boxState.set(id, { value: 0, phase: "idle", elapsed: 0, attack: parseFloat(args[0]) || 0.1, release: parseFloat(args[1]) || 0.5 });
      break;
    case "adsr":
      boxState.set(id, { value: 0, phase: "idle", elapsed: 0, a: parseFloat(args[0]) || 0.05, d: parseFloat(args[1]) || 0.1, s: parseFloat(args[2]) || 0.7, r: parseFloat(args[3]) || 0.3, gateOpen: false });
      break;
    case "ramp":
      boxState.set(id, { value: parseFloat(args[0]) || 0, from: parseFloat(args[0]) || 0, to: parseFloat(args[1]) || 1, duration: parseFloat(args[2]) || 0.5, phase: "idle", elapsed: 0 });
      break;
    case "delay":
      boxState.set(id, { queue: [], time: parseFloat(args[0]) || 0.5 });
      break;
    case "slew":
      boxState.set(id, { value: 0, target: 0, rate: parseFloat(args[0]) || 0.05 });
      break;
    case "lag":
      boxState.set(id, { value: 0, target: 0, coeff: parseFloat(args[0]) || 0.2 });
      break;
    case "sample-hold":
      boxState.set(id, { value: 0 });
      break;
    case "sig": {
      const values = expandIntegerNotation(args[0] || "1");
      const behaviour = args[1] || "shuffle";
      boxState.set(id, { values: [...values], behaviour, index: Math.floor(Math.random() * values.length) });
      break;
    }
    case "step": {
      boxState.set(id, { active: false, remaining: 0, amplitude: parseFloat(args[0]) || 1, length: parseFloat(args[1]) || 0.5 });
      break;
    }
    case "random": {
      const min = parseFloat(args[0]) || 0, max = parseFloat(args[1]) || 1;
      boxState.set(id, { min, max, value: min + Math.random() * (max - min) });
      break;
    }
  }
}

function shouldServerEval(box: Box): boolean {
  const zone = getBoxZone(box.text);
  if (zone === "synth") return false;
  if (zone === "any" && isSynthZone(box.x, box.y)) return false;
  return true;
}

function initAllBoxState(): void {
  boxState.clear();
  for (const [id, box] of boxes) {
    if (!shouldServerEval(box)) continue;
    initBoxState(id, box);
  }
}

const TICK_RATE = 60;
const TICK_DT = 1 / TICK_RATE;

function tick(): void {
  for (const [id, box] of boxes) {
    if (!shouldServerEval(box)) continue;
    const name = boxTypeName(box.text);
    const state = boxState.get(id);
    if (!state) continue;

    switch (name) {
      case "phasor": {
        if (state.paused) break;
        state.phase += TICK_DT / state.period;
        if (state.phase >= 1) {
          if (state.loop) {
            state.phase -= 1;
          } else {
            state.phase = 1;
            state.paused = true;
          }
          propagateAndNotify(id, 1, 0);
        }
        setBoxValueAndNotify(id, state.phase);
        break;
      }
      case "metro": {
        if (state.paused) break;
        state.elapsed += TICK_DT;
        if (state.elapsed >= state.interval) {
          state.elapsed -= state.interval;
          propagateAndNotify(id, 0, 1);
        }
        queueValueUpdate(id, state.elapsed / state.interval);
        break;
      }
      case "delay": {
        for (let i = state.queue.length - 1; i >= 0; i--) {
          state.queue[i].remaining -= TICK_DT;
          if (state.queue[i].remaining <= 0) {
            propagateAndNotify(id, 0, state.queue[i].value);
            state.queue.splice(i, 1);
          }
        }
        break;
      }
      case "ar": {
        if (state.phase === "idle") break;
        state.elapsed += TICK_DT;
        if (state.phase === "attack") {
          state.value = Math.min(1, state.elapsed / state.attack);
          if (state.elapsed >= state.attack) { state.phase = "release"; state.elapsed = 0; }
        } else if (state.phase === "release") {
          state.value = Math.max(0, 1 - state.elapsed / state.release);
          if (state.elapsed >= state.release) { state.value = 0; state.phase = "idle"; propagateAndNotify(id, 1, 0); }
        }
        boxValues.set(id, state.value);
        queueValueUpdate(id, state.value);
        propagateAndNotify(id, 0, state.value);
        break;
      }
      case "adsr": {
        const gateNow = (inletValues.get(id)?.[0] || 0) > 0;
        if (gateNow && !state.gateOpen) { state.gateOpen = true; state.phase = "attack"; state.elapsed = 0; }
        else if (!gateNow && state.gateOpen) { state.gateOpen = false; if (state.phase !== "idle") { state.phase = "release"; state.elapsed = 0; } }
        if (state.phase === "idle") break;
        state.elapsed += TICK_DT;
        if (state.phase === "attack") {
          state.value = Math.min(1, state.elapsed / state.a);
          if (state.elapsed >= state.a) { state.phase = "decay"; state.elapsed = 0; }
        } else if (state.phase === "decay") {
          state.value = 1 - (1 - state.s) * Math.min(1, state.elapsed / state.d);
          if (state.elapsed >= state.d) { state.phase = "sustain"; state.value = state.s; }
        } else if (state.phase === "sustain") {
          state.value = state.s;
        } else if (state.phase === "release") {
          const sv = state.value;
          state.value = sv * Math.max(0, 1 - state.elapsed / state.r);
          if (state.elapsed >= state.r) { state.value = 0; state.phase = "idle"; propagateAndNotify(id, 1, 0); }
        }
        boxValues.set(id, state.value);
        queueValueUpdate(id, state.value);
        propagateAndNotify(id, 0, state.value);
        break;
      }
      case "ramp": {
        if (state.phase !== "running") break;
        state.elapsed += TICK_DT;
        const t = Math.min(1, state.elapsed / state.duration);
        state.value = state.from + (state.to - state.from) * t;
        boxValues.set(id, state.value);
        queueValueUpdate(id, state.value);
        propagateAndNotify(id, 0, state.value);
        if (t >= 1) { state.phase = "idle"; propagateAndNotify(id, 1, 0); }
        break;
      }
      case "slew": {
        const iv = inletValues.get(id);
        if (iv) state.target = iv[0] || 0;
        if (Math.abs(state.value - state.target) > 0.0001) {
          const maxDelta = TICK_DT / state.rate;
          const diff = state.target - state.value;
          state.value += Math.sign(diff) * Math.min(Math.abs(diff), maxDelta);
          setBoxValueAndNotify(id, state.value);
        }
        break;
      }
      case "lag": {
        const iv = inletValues.get(id);
        if (iv) state.target = iv[0] || 0;
        if (Math.abs(state.value - state.target) > 0.0001) {
          const alpha = 1 - Math.exp(-TICK_DT / state.coeff);
          state.value += (state.target - state.value) * alpha;
          setBoxValueAndNotify(id, state.value);
        }
        break;
      }
    }
  }
}

// handle number inlets on stateful boxes — returns true if handled
function handleStatefulInlet(id: number, inlet: number, value: number): boolean {
  const box = boxes.get(id);
  if (!box) return false;
  const name = boxTypeName(box.text);
  const state = boxState.get(id);
  if (!state) return false;

  if (name === "phasor") {
    if (inlet === 0) { state.paused = value > 0; return true; }
    if (inlet === 2) { state.period = Math.max(0.001, value); return true; }
  }
  if (name === "metro") {
    if (inlet === 0) { state.paused = !(value > 0); return true; }
    if (inlet === 1) { state.interval = Math.max(0.001, value); return true; }
  }
  if (name === "toggle" && inlet === 0) {
    state.value = value > 0 ? 1 : 0;
    setBoxValueAndNotify(id, state.value);
    return true;
  }
  // slew/lag: inlet 0 sets target, tick does the smoothing
  if (name === "slew" || name === "lag") {
    if (inlet === 0) { state.target = value; return true; }
  }
  // sample-hold: inlet 0 is the value to sample (stored in inletValues), inlet 1 is trigger (handled by handleEventBox)
  if (name === "sample-hold" && inlet === 0) {
    return true;
  }
  // adsr: inlet 0 is gate — store for tick loop
  if (name === "adsr" && inlet === 0) {
    return true;
  }
  // ar: inlets 1,2 are attack/release time overrides — store for tick
  if (name === "ar") {
    if (inlet === 1) { state.attack = Math.max(0.001, value); return true; }
    if (inlet === 2) { state.release = Math.max(0.001, value); return true; }
  }
  // ramp: not triggered by number inlets, just stores
  return false;
}

// handle event-driven boxes (triggered by incoming null events)
function handleEventBox(id: number, _value: number): void {
  const box = boxes.get(id);
  if (!box) return;
  const name = boxTypeName(box.text);
  const state = boxState.get(id);
  if (!state) return;

  switch (name) {
    case "phasor": {
      state.phase = 0;
      setBoxValueAndNotify(id, 0);
      break;
    }
    case "sequence": {
      state.index = (state.index + 1) % state.values.length;
      const val = state.values[state.index];
      setBoxValueAndNotify(id, val);
      break;
    }
    case "counter": {
      state.count++;
      if (state.count > state.max) state.count = state.min;
      setBoxValueAndNotify(id, state.count);
      break;
    }
    case "drunk": {
      state.value += (Math.random() * 2 - 1) * state.step;
      state.value = Math.max(0, Math.min(1, state.value));
      setBoxValueAndNotify(id, state.value);
      break;
    }
    case "ar": {
      state.phase = "attack"; state.elapsed = 0;
      break;
    }
    case "ramp": {
      state.phase = "running"; state.elapsed = 0;
      break;
    }
    case "delay": {
      state.queue.push({ value: _value, remaining: state.time });
      break;
    }
    case "sample-hold": {
      // on trigger (inlet 1), sample the current value of inlet 0
      const iv = inletValues.get(id);
      state.value = iv?.[0] || 0;
      setBoxValueAndNotify(id, state.value);
      break;
    }
    case "sig": {
      const val = advanceSig(state);
      setBoxValueAndNotify(id, val);
      break;
    }
    case "step": {
      const iv = inletValues.get(id);
      const amp = iv?.[1] !== undefined ? iv[1] : state.amplitude;
      const len = iv?.[2] !== undefined ? iv[2] : state.length;
      state.active = true;
      state.remaining = len;
      setBoxValueAndNotify(id, amp);
      break;
    }
    case "random": {
      state.value = state.min + Math.random() * (state.max - state.min);
      setBoxValueAndNotify(id, state.value);
      break;
    }
  }
}

setInterval(tick, 1000 / TICK_RATE);

// --- MIDI CC mapping ---

const CC_SOURCE: Record<number, string> = { 2: "breath", 1: "bite", 12: "nod", 13: "tilt" };

function findBoxByText(text: string): number | null {
  for (const [id, box] of boxes) if (box.text === text) return id;
  return null;
}

// --- Edit handling ---

function removeCablesForBox(boxId: number): void {
  for (const [id, c] of cables) if (c.srcBox === boxId || c.dstBox === boxId) cables.delete(id);
}

// --- Abstraction expansion ---

function expandAbstractions(): number {
  let idOffset = 100000;
  let nextCableId = patchNextId + 50000;

  for (const [boxId, box] of [...boxes]) {
    const absName = boxTypeName(box.text);
    const absDef = loadedAbstractions.get(absName);
    if (!absDef) continue;

    // Build inlet/outlet index → internal box mapping
    const inletMap = new Map<number, number>();   // inlet index → local box id
    const outletMap = new Map<number, number>();  // outlet index → local box id

    for (const [localId, intBox] of absDef.boxes) {
      const type = boxTypeName(intBox.text);
      const idx = parseInt(intBox.text.split(/\s+/)[1]) || 0;
      if (type === "inlet") inletMap.set(idx, localId);
      if (type === "outlet") outletMap.set(idx, localId);
    }

    // Clone internal boxes (excluding inlet/outlet boxes)
    const localToGlobal = new Map<number, number>();
    for (const [localId, intBox] of absDef.boxes) {
      const type = boxTypeName(intBox.text);
      if (type === "inlet" || type === "outlet") continue;

      const globalId = localId + idOffset;
      localToGlobal.set(localId, globalId);
      // Clone box with position offset from abstraction instance
      const clonedBox = { ...intBox, x: intBox.x, y: intBox.y };
      const p = getBoxPorts(clonedBox.text);
      clonedBox.inlets = p.inlets;
      clonedBox.outlets = p.outlets;
      boxes.set(globalId, clonedBox);
    }

    // Clone internal cables (skip those touching inlet/outlet)
    for (const [, cable] of absDef.cables) {
      const srcBox = absDef.boxes.get(cable.srcBox);
      const dstBox = absDef.boxes.get(cable.dstBox);
      const srcType = srcBox ? boxTypeName(srcBox.text) : "";
      const dstType = dstBox ? boxTypeName(dstBox.text) : "";

      if (srcType === "inlet" || dstType === "outlet") continue;

      const srcGlobal = localToGlobal.get(cable.srcBox);
      const dstGlobal = localToGlobal.get(cable.dstBox);
      if (srcGlobal === undefined || dstGlobal === undefined) continue;

      cables.set(nextCableId++, {
        srcBox: srcGlobal,
        srcOutlet: cable.srcOutlet,
        dstBox: dstGlobal,
        dstInlet: cable.dstInlet,
      });
    }

    // Rewire external cables through inlet/outlet
    for (const [cableId, cable] of [...cables]) {
      if (cable.dstBox === boxId) {
        // Cable INTO abstraction: find what inlet N connects to
        const inletLocalId = inletMap.get(cable.dstInlet);
        if (inletLocalId === undefined) {
          cables.delete(cableId);
          continue;
        }
        // Find cables from inlet box to internal boxes
        for (const [, intCable] of absDef.cables) {
          if (intCable.srcBox === inletLocalId) {
            const targetGlobal = localToGlobal.get(intCable.dstBox);
            if (targetGlobal !== undefined) {
              cables.set(nextCableId++, {
                srcBox: cable.srcBox,
                srcOutlet: cable.srcOutlet,
                dstBox: targetGlobal,
                dstInlet: intCable.dstInlet,
              });
            }
          }
        }
        cables.delete(cableId);
      }

      if (cable.srcBox === boxId) {
        // Cable FROM abstraction: find what connects to outlet N
        const outletLocalId = outletMap.get(cable.srcOutlet);
        if (outletLocalId === undefined) {
          cables.delete(cableId);
          continue;
        }
        for (const [, intCable] of absDef.cables) {
          if (intCable.dstBox === outletLocalId) {
            const sourceGlobal = localToGlobal.get(intCable.srcBox);
            if (sourceGlobal !== undefined) {
              cables.set(nextCableId++, {
                srcBox: sourceGlobal,
                srcOutlet: intCable.srcOutlet,
                dstBox: cable.dstBox,
                dstInlet: cable.dstInlet,
              });
            }
          }
        }
        cables.delete(cableId);
      }
    }

    // Remove the abstraction instance box
    boxes.delete(boxId);
    idOffset += 10000;
  }

  return nextCableId;
}

// --- Apply (replaces entire graph state from ctrl) ---

// deno-lint-ignore no-explicit-any
function handleApply(msg: any): void {
  boxes.clear(); cables.clear(); boxValues.clear(); inletValues.clear(); boxState.clear();
  for (const [id, box] of msg.boxes) {
    const p = getBoxPorts(box.text);
    box.inlets = p.inlets; box.outlets = p.outlets;
    boxes.set(id, box);
    // snap routers to border
    if (getBoxZone(box.text) === "router") {
      box.y = synthBorderY - 11;
    }
  }
  for (const [id, cable] of msg.cables) cables.set(id, cable);
  patchNextId = msg.nextId || 1;
  if (msg.synthBorderY !== undefined) synthBorderY = msg.synthBorderY;

  // expand abstractions inline
  expandAbstractions();

  // rebuild ctrl evaluation
  initAllBoxState();
  evaluateAllConsts();

  // rebuild grid regions
  rebuildGridRegions();

  // deploy synth patch to clients
  deployPatch();

  // confirm to ctrl
  sendCtrl({ type: "applied" });
  status.applied = true;
  event("patch applied");
}

// deno-lint-ignore no-explicit-any
function handleEdit(msg: any): void {
  switch (msg.action) {
    case "box-create": {
      const ports = getBoxPorts(msg.text || "");
      const newBox = { x: msg.x, y: msg.y, text: msg.text || "", inlets: ports.inlets, outlets: ports.outlets };
      boxes.set(msg.id, newBox);
      if (msg.id >= patchNextId) patchNextId = msg.id + 1;
      if (shouldServerEval(newBox)) initBoxState(msg.id, newBox);
      rebuildGridRegions();
      break;
    }
    case "box-move": {
      for (const m of msg.moves) {
        const box = boxes.get(m.id);
        if (box) { box.x = m.x; box.y = m.y; }
      }
      break;
    }
    case "box-text": {
      const box = boxes.get(msg.id);
      if (!box) break;
      box.text = msg.text;
      const ports = getBoxPorts(msg.text);
      box.inlets = ports.inlets; box.outlets = ports.outlets;
      // prune cables with invalid ports
      for (const [cid, c] of cables) {
        if (c.srcBox === msg.id && c.srcOutlet >= box.outlets) cables.delete(cid);
        if (c.dstBox === msg.id && c.dstInlet >= box.inlets) cables.delete(cid);
      }
      // snap router to border
      if (getBoxZone(msg.text) === "router") box.y = synthBorderY - 11;
      // zone enforcement
      const zone = getBoxZone(msg.text);
      if (zone === "synth" && !isSynthZone(box.x, box.y)) box.y = synthBorderY + 20;
      else if (zone === "ctrl" && isSynthZone(box.x, box.y)) box.y = synthBorderY - 42;
      // re-init state and re-evaluate
      boxState.delete(msg.id);
      if (shouldServerEval(box)) initBoxState(msg.id, box);
      inletValues.delete(msg.id);
      evaluateAllConsts();
      rebuildGridRegions();
      break;
    }
    case "box-delete": {
      for (const id of msg.ids) { removeCablesForBox(id); boxes.delete(id); boxValues.delete(id); inletValues.delete(id); boxState.delete(id); }
      rebuildGridRegions();
      break;
    }
    case "cable-create": {
      cables.set(msg.id, { srcBox: msg.srcBox, srcOutlet: msg.srcOutlet, dstBox: msg.dstBox, dstInlet: msg.dstInlet });
      if (msg.id >= patchNextId) patchNextId = msg.id + 1;
      evaluateAllConsts();
      break;
    }
    case "cable-delete": {
      for (const id of msg.ids) cables.delete(id);
      break;
    }
    case "border-move": {
      synthBorderY = msg.y;
      // snap all routers
      for (const [, box] of boxes) if (getBoxZone(box.text) === "router") box.y = synthBorderY - 11;
      break;
    }
    case "deploy": {
      deployPatch();
      break;
    }
  }
}

// --- Deploy ---

function serializeSynthPatch(): Record<string, unknown> {
  // deno-lint-ignore no-explicit-any
  const patchBoxes: any[] = [], patchCables: any[] = [], entries: any[] = [];
  const synthIds = new Set<number>();

  for (const [id, box] of boxes) {
    const def = getBoxDef(box.text);
    if (!def) continue;
    if (def.zone === "synth" || (def.zone === "any" && isSynthZone(box.x, box.y))) {
      synthIds.add(id);
      const name = boxTypeName(box.text), args = box.text.split(/\s+/).slice(1).join(" ");
      const isEngine = def.outlets.length === 0 && def.inlets.length > 0;
      // deno-lint-ignore no-explicit-any
      const pb: any = { id, type: name, args };
      if (isEngine) { pb.engine = true; pb.paramNames = def.inlets.map((i: { name: string }) => i.name); }
      patchBoxes.push(pb);
    }
  }

  for (const [, c] of cables) {
    if (synthIds.has(c.srcBox) && synthIds.has(c.dstBox))
      patchCables.push({ srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet });
  }

  for (const [id, box] of boxes) {
    const def = getBoxDef(box.text);
    if (!def || def.zone !== "router") continue;
    const channels = box.outlets || 1;
    for (let ch = 0; ch < channels; ch++) {
      for (const c of cablesFromOutlet(id, ch)) {
        if (synthIds.has(c.dstBox)) entries.push({ routerId: id, routerOutlet: ch, targetBox: c.dstBox, targetInlet: c.dstInlet });
      }
    }
  }

  // collect current boxValues for all router entries as initialValues
  const initialValues: Record<string, number> = {};
  for (const entry of entries) {
    const key = entry.routerId + ":" + (entry.routerOutlet || 0);
    // find the current value flowing into this router channel
    for (const [, c] of cables) {
      if (c.dstBox === entry.routerId && c.dstInlet === entry.routerOutlet) {
        const val = boxValues.get(c.srcBox);
        if (val !== undefined) initialValues[key] = val;
      }
    }
  }

  return { type: "patch", boxes: patchBoxes, cables: patchCables, entries, initialValues };
}

function deployPatch(): void {
  deployedPatch = serializeSynthPatch();
  latestValues.clear();
  broadcastSynth(deployedPatch);
  event("patch deployed to " + totalSynthClients() + " clients");
  sendCtrl({ type: "deployed" });
  // re-evaluate consts so rv messages flow immediately after deploy
  evaluateAllConsts();
}

// --- Full state sync for ctrl ---

function getFullState(): Record<string, unknown> {
  const bv: Record<number, number> = {};
  for (const [id, v] of boxValues) bv[id] = v;
  return {
    type: "state",
    boxes: [...boxes.entries()],
    cables: [...cables.entries()],
    nextId: patchNextId,
    synthBorderY,
    boxValues: bv,
  };
}

function sendFullState(): void {
  sendCtrl(getFullState());
}

// --- Ctrl WebSocket handler ---

function handleCtrlWs(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.addEventListener("open", () => {
    ctrlSockets.add(socket);
    event("ctrl connected");
    drawStatus();
    socket.send(JSON.stringify(getFullState()));
    socket.send(JSON.stringify({ type: "count", clients: totalSynthClients() }));
    if (gridDeviceInfo) {
      socket.send(JSON.stringify({ type: "grid-connected", deviceType: gridDeviceInfo.deviceType, deviceId: gridDeviceInfo.deviceId }));
    }
    if (arcDeviceInfo) {
      socket.send(JSON.stringify({ type: "arc-connected", deviceType: arcDeviceInfo.deviceType, deviceId: arcDeviceInfo.deviceId }));
    }
  });

  socket.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "apply") {
        handleApply(msg);
      } else if (msg.type === "midi") {
        if (msg.cc !== undefined) {
          const name = CC_SOURCE[msg.cc];
          if (name) {
            const id = findBoxByText(name);
            if (id !== null) setBoxValueAndNotify(id, msg.value / 127);
          }
        } else if (msg.note !== undefined) {
          const id = findBoxByText("key");
          if (id !== null) setBoxValueAndNotify(id, msg.note);
        }
      } else if (msg.type === "toggle-click") {
        const state = boxState.get(msg.id);
        if (state) {
          state.value = msg.value;
          setBoxValueAndNotify(msg.id, state.value);
        }
      } else if (msg.type === "event-click") {
        propagateAndNotify(msg.id, 0, 1);
      } else if (msg.type === "health") {
        socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
      }
    } catch (err) { console.error("WS error:", err); }
  });

  socket.addEventListener("close", () => {
    ctrlSockets.delete(socket);
    event("ctrl disconnected");
    drawStatus();
  });

  return response;
}

// --- Synth WebSocket handler ---

function handleSynthWs(req: Request, info: Deno.ServeHandlerInfo): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const id = nextClientId++;
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;

  socket.addEventListener("open", () => {
    synthWsClients.set(id, socket);
    trackConnect(clientIP, id);
    drawStatus();
    socket.send(JSON.stringify({ type: "welcome", id, clients: totalSynthClients() }));
    if (deployedPatch) {
      socket.send(JSON.stringify(deployedPatch));
      for (const data of latestValues.values()) socket.send(data);
    }
    broadcastClientCount();
  });

  socket.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "health") {
        socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
      }
    } catch (err) { console.error("WS error:", err); }
  });

  socket.addEventListener("close", () => {
    synthWsClients.delete(id);
    trackDisconnect(clientIP, id);
    drawStatus();
    broadcastClientCount();
  });

  return response;
}

// --- SSE handler ---

function handleSSE(req: Request, info: Deno.ServeHandlerInfo): Response {
  const id = nextClientId++;
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send: SSESend = (data) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { /* stream closed */ }
      };
      sseClients.set(id, send);
      trackConnect(clientIP, id);
      drawStatus();
      send({ type: "welcome", id, clients: totalSynthClients() });
      if (deployedPatch) {
        send(deployedPatch);
        for (const data of latestValues.values()) send(JSON.parse(data));
      }
      broadcastClientCount();
    },
    cancel() {
      sseClients.delete(id);
      trackDisconnect(clientIP, id);
      drawStatus();
      broadcastClientCount();
    },
  });

  req.signal.addEventListener("abort", () => {
    sseClients.delete(id);
    trackDisconnect(clientIP, id);
    broadcastClientCount();
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" },
  });
}

// --- Captive portal (HTTP) ---

function portalHandler(req: Request, info: Deno.ServeHandlerInfo): Response | Promise<Response> {
  const url = new URL(req.url);
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;
  const probes = ["/hotspot-detect.html", "/generate_204", "/canonical.html", "/connecttest.txt"];

  if (probes.includes(url.pathname)) {
    if (authenticatedIPs.has(clientIP)) {
      if (url.pathname === "/generate_204") return new Response(null, { status: 204 });
      if (url.pathname === "/connecttest.txt") return new Response("Microsoft Connect Test", { headers: { "content-type": "text/plain" } });
      return new Response("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>", { headers: { "content-type": "text/html" } });
    }
    event(`CNA redirect ${clientIP}`);
    return Response.redirect(`https://${HOST_DOMAIN}:${HTTPS_PORT}`, 302);
  }

  if (url.pathname === "/auth") { authenticatedIPs.add(clientIP); return new Response("ok"); }
  if (url.pathname === "/events") return handleSSE(req, info);
  // route WebSocket by path
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (url.pathname === "/ws/ctrl") return handleCtrlWs(req);
    return handleSynthWs(req, info);
  }
  const ext = url.pathname.split(".").pop()?.toLowerCase();
  if (ext && ["js", "css", "json", "png", "ico"].includes(ext)) return serveFile(url.pathname);
  return serveFile("/index.html");
}

// --- Patch storage API ---

const PATCHES_DIR = "./patches";
const ABSTRACTIONS_DIR = "./abstractions";
await Deno.mkdir(PATCHES_DIR, { recursive: true });
await Deno.mkdir(ABSTRACTIONS_DIR, { recursive: true });

// --- Abstraction loading ---

interface AbstractionDef {
  boxes: Map<number, any>;
  cables: Map<number, any>;
}

const loadedAbstractions = new Map<string, AbstractionDef>();

async function loadAbstractions(): Promise<void> {
  loadedAbstractions.clear();
  try {
    for await (const entry of Deno.readDir(ABSTRACTIONS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const name = entry.name.replace(".json", "");
      try {
        const data = JSON.parse(await Deno.readTextFile(`${ABSTRACTIONS_DIR}/${entry.name}`));
        const absBoxes = new Map<number, any>();
        const absCables = new Map<number, any>();
        for (const [id, box] of data.boxes) absBoxes.set(id, box);
        for (const [id, cable] of data.cables) absCables.set(id, cable);
        loadedAbstractions.set(name, { boxes: absBoxes, cables: absCables });
      } catch (e) {
        console.error(`Failed to load abstraction ${name}:`, e);
      }
    }
    event(`loaded ${loadedAbstractions.size} abstraction(s)`);
  } catch {
    // Directory may not exist yet
  }
}

// Load abstractions on startup
await loadAbstractions();

function sanitizeName(name: string): string | null {
  const clean = name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim();
  return clean.length > 0 ? clean : null;
}

async function handlePatchAPI(req: Request, url: URL): Promise<Response> {
  const headers = { "content-type": "application/json" };

  // GET /patches — list saved patches
  if (req.method === "GET" && url.pathname === "/patches") {
    const patches: string[] = [];
    for await (const entry of Deno.readDir(PATCHES_DIR)) {
      if (entry.isFile && entry.name.endsWith(".json")) patches.push(entry.name.replace(".json", ""));
    }
    patches.sort();
    return new Response(JSON.stringify(patches), { headers });
  }

  // GET /patches/name — load a patch
  if (req.method === "GET" && url.pathname.startsWith("/patches/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(9)));
    if (!name) return new Response("Invalid name", { status: 400 });
    try {
      const data = await Deno.readTextFile(`${PATCHES_DIR}/${name}.json`);
      return new Response(data, { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // PUT /patches/name — save a patch
  if (req.method === "PUT" && url.pathname.startsWith("/patches/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(9)));
    if (!name) return new Response("Invalid name", { status: 400 });
    const data = await req.text();
    await Deno.writeTextFile(`${PATCHES_DIR}/${name}.json`, data);
    event(`saved patch: ${name}`);
    return new Response(JSON.stringify({ ok: true, name }), { headers });
  }

  // DELETE /patches/name — delete a patch
  if (req.method === "DELETE" && url.pathname.startsWith("/patches/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(9)));
    if (!name) return new Response("Invalid name", { status: 400 });
    try {
      await Deno.remove(`${PATCHES_DIR}/${name}.json`);
      event(`deleted patch: ${name}`);
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  return new Response("Not found", { status: 404 });
}

// --- Abstraction storage API ---

async function handleAbstractionAPI(req: Request, url: URL): Promise<Response> {
  const headers = { "content-type": "application/json" };

  // GET /abstractions — list available abstractions
  if (req.method === "GET" && url.pathname === "/abstractions") {
    const abstractions: string[] = [];
    for await (const entry of Deno.readDir(ABSTRACTIONS_DIR)) {
      if (entry.isFile && entry.name.endsWith(".json")) abstractions.push(entry.name.replace(".json", ""));
    }
    abstractions.sort();
    return new Response(JSON.stringify(abstractions), { headers });
  }

  // GET /abstractions/name — load an abstraction
  if (req.method === "GET" && url.pathname.startsWith("/abstractions/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(14)));
    if (!name) return new Response("Invalid name", { status: 400 });
    try {
      const data = await Deno.readTextFile(`${ABSTRACTIONS_DIR}/${name}.json`);
      return new Response(data, { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // PUT /abstractions/name — save an abstraction
  if (req.method === "PUT" && url.pathname.startsWith("/abstractions/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(14)));
    if (!name) return new Response("Invalid name", { status: 400 });
    const data = await req.text();
    await Deno.writeTextFile(`${ABSTRACTIONS_DIR}/${name}.json`, data);
    event(`saved abstraction: ${name}`);
    await loadAbstractions();  // Reload registry
    return new Response(JSON.stringify({ ok: true, name }), { headers });
  }

  // DELETE /abstractions/name — delete an abstraction
  if (req.method === "DELETE" && url.pathname.startsWith("/abstractions/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(14)));
    if (!name) return new Response("Invalid name", { status: 400 });
    try {
      await Deno.remove(`${ABSTRACTIONS_DIR}/${name}.json`);
      event(`deleted abstraction: ${name}`);
      await loadAbstractions();  // Reload registry
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  return new Response("Not found", { status: 404 });
}

// --- HTTPS handler ---

function httpsHandler(req: Request, info: Deno.ServeHandlerInfo): Response | Promise<Response> {
  const url = new URL(req.url);
  // route WebSocket by path
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (url.pathname === "/ws/ctrl") return handleCtrlWs(req);
    return handleSynthWs(req, info);
  }
  if (url.pathname === "/events") return handleSSE(req, info);
  if (url.pathname === "/auth") { authenticatedIPs.add((info.remoteAddr as Deno.NetAddr).hostname); return new Response("ok"); }
  if (url.pathname.startsWith("/patches")) return handlePatchAPI(req, url);
  if (url.pathname.startsWith("/abstractions")) return handleAbstractionAPI(req, url);
  return serveFile(url.pathname === "/" ? "/index.html" : url.pathname);
}

// --- Start ---

const tlsAvailable = await hasCerts();

// Check if HOST_IP is configured (especially important on macOS)
const isMacOS = Deno.build.os === "darwin";
const isDefaultIP = HOST_IP === "192.168.178.10";
const macIPExpected = "192.168.178.24";

if (isMacOS && isDefaultIP) {
  console.log("\x1b[33m⚠️  WARNING: HOST_IP not set!\x1b[0m");
  console.log("\x1b[33mUsing default IP (192.168.178.10) but you're on macOS.\x1b[0m");
  console.log("\x1b[33mFor macOS deployment, you should run:\x1b[0m");
  console.log(`\x1b[33m  sudo HOST_IP=${macIPExpected} deno task start\x1b[0m`);
  console.log("");
}

// Check if dnsmasq is running (required for captive portal)
if (isMacOS && tlsAvailable) {
  try {
    const dnsCheck = await Deno.resolveDns("test.example.com", "A", { nameServer: { ipAddr: HOST_IP, port: 53 } });
    const allPointToHost = dnsCheck.every(record => record === HOST_IP);
    if (!allPointToHost) {
      console.log("\x1b[33m⚠️  WARNING: dnsmasq may not be configured correctly!\x1b[0m");
      console.log("\x1b[33mCaptive portal requires all DNS queries to resolve to ${HOST_IP}\x1b[0m");
      console.log("\x1b[33mStart dnsmasq with:\x1b[0m");
      console.log("\x1b[33m  ./start-macos.sh dns\x1b[0m");
      console.log("");
    }
  } catch {
    console.log("\x1b[33m⚠️  WARNING: dnsmasq is not running!\x1b[0m");
    console.log("\x1b[33mCaptive portal requires dnsmasq for DNS resolution.\x1b[0m");
    console.log("\x1b[33mStart dnsmasq with:\x1b[0m");
    console.log("\x1b[33m  ./start-macos.sh dns\x1b[0m");
    console.log("");
  }
}

// Check if serialosc is running (required for monome grid/arc)
if (isMacOS) {
  try {
    const psOutput = await new Deno.Command("pgrep", { args: ["serialoscd"] }).output();
    if (!psOutput.success) {
      console.log("\x1b[33m⚠️  WARNING: serialosc is not running!\x1b[0m");
      console.log("\x1b[33mMonome grid/arc require serialosc daemon.\x1b[0m");
      console.log("\x1b[33mStart serialosc with:\x1b[0m");
      console.log("\x1b[33m  brew services start serialosc\x1b[0m");
      console.log("");
    } else {
      // serialosc is running — initialize grid and arc (both via OSC)
      await initGrid();
    }
  } catch {
    // pgrep not found or other error - skip check
  }
}

const banner = `
  \x1b[1mlocal.assembly.fm\x1b[0m
  ${tlsAvailable ? "HTTPS + HTTP portal" : "dev mode (HTTP only)"}
  Server IP: ${HOST_IP}
  synth:    ${tlsAvailable ? `https://${HOST_DOMAIN}/` : `http://localhost:${HTTP_PORT}/`}
  ctrl:     ${tlsAvailable ? `https://${HOST_DOMAIN}/ctrl.html` : `http://localhost:${HTTP_PORT}/ctrl.html`}
  ensemble: ${tlsAvailable ? `https://${HOST_DOMAIN}/ensemble.html` : `http://localhost:${HTTP_PORT}/ensemble.html`}
`;
console.log(banner);

if (tlsAvailable) {
  Deno.serve({ port: HTTP_PORT, hostname: "0.0.0.0" }, (req, info) => portalHandler(req, info));
  Deno.serve({ port: HTTPS_PORT, cert: await Deno.readTextFile(CERT_FILE), key: await Deno.readTextFile(KEY_FILE) }, (req, info) => httpsHandler(req, info));
} else {
  Deno.serve({ port: HTTP_PORT, hostname: "0.0.0.0" }, (req, info) => httpsHandler(req, info));
}

drawStatus();

setInterval(() => {
  broadcastSynth({ type: "health", ts: Date.now() });
  for (const socket of ctrlSockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
  }
}, 5000);
