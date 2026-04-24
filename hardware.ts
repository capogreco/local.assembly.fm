// hardware.ts — monome grid, arc, and OSC/serialosc support
// Extracted from server.ts as part of the server split.

import { type BoxValue, boxes, boxValues } from "./patch-state.ts";

// --- Callbacks injected by server.ts ---

let _setBoxValueAndNotify: (boxId: number, value: BoxValue) => void;
let _sendCtrl: (msg: Record<string, unknown>) => void;
let _event: (msg: string) => void;
let _boxTypeName: (text: string) => string;
let _getBoxDef: (text: string) => { outlets: { name: string }[] } | null;

export function initHardware(deps: {
  setBoxValueAndNotify: (boxId: number, value: BoxValue) => void;
  sendCtrl: (msg: Record<string, unknown>) => void;
  event: (msg: string) => void;
  boxTypeName: (text: string) => string;
  // deno-lint-ignore no-explicit-any
  getBoxDef: (text: string) => any;
}): void {
  _setBoxValueAndNotify = deps.setBoxValueAndNotify;
  _sendCtrl = deps.sendCtrl;
  _event = deps.event;
  _boxTypeName = deps.boxTypeName;
  _getBoxDef = deps.getBoxDef;
}

// --- OSC / Monome Grid Constants ---

const SERIALOSC_PORT = 12002;
const GRID_LISTEN_PORT = 13000;
const GRID_PREFIX = "/assembly";
const ARC_PREFIX = "/assembly";
const ARC_SENSITIVITY = 0.0003;

// --- Grid state ---

let gridSocket: Deno.DatagramConn | null = null;
let gridDevicePort: number | null = null;
const gridDeviceHost = "127.0.0.1";
let gridDeviceInfo: { deviceType: string; deviceId: string } | null = null;

// --- Grid region state ---

interface GridRegion {
  boxId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: "grid-trig" | "grid-toggle" | "grid-array";
}

interface GridArrayState {
  array: number[];
  heldButtons: Set<number>;
  rangeGestureActive: boolean;
}

const gridRegions = new Map<number, GridRegion>();
const gridToggleStates = new Map<number, boolean>();
const gridArrayStates = new Map<number, GridArrayState>();

// --- Arc state ---

interface ArcEncoder {
  boxId: number;
  encoder: number;
  mode: number;
}

const arcEncoders = new Map<number, ArcEncoder>();
export const arcValues = new Map<number, number>();

let arcReady = false;
let arcDevicePort: number | null = null;
let arcDeviceInfo: { deviceType: string; deviceId: string } | null = null;

// --- OSC message encoding ---

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

// --- OSC message parsing ---

function parseOsc(data: Uint8Array): { address: string; args: (string | number)[] } | null {
  let offset = 0;

  const addressEnd = data.indexOf(0, offset);
  if (addressEnd === -1) return null;
  const address = new TextDecoder().decode(data.slice(offset, addressEnd));
  offset = Math.ceil((addressEnd + 1) / 4) * 4;

  if (offset >= data.length) return null;
  const typeTagEnd = data.indexOf(0, offset);
  if (typeTagEnd === -1) return null;
  const typeTags = new TextDecoder().decode(data.slice(offset + 1, typeTagEnd));
  offset = Math.ceil((typeTagEnd + 1) / 4) * 4;

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

// --- Grid communication ---

function gridSend(address: string, typeTags: string, ...args: (string | number)[]): void {
  if (!gridSocket || gridDevicePort === null) {
    _event(`gridSend failed: socket=${!!gridSocket} port=${gridDevicePort}`);
    return;
  }
  _event(`gridSend → port ${gridDevicePort}: ${GRID_PREFIX}${address} [${args.join(", ")}]`);
  const msg = oscMessage(GRID_PREFIX + address, typeTags, ...args);
  gridSocket.send(msg, { transport: "udp", hostname: gridDeviceHost, port: gridDevicePort });
}

function gridSysSend(address: string, typeTags: string, ...args: (string | number)[]): void {
  if (!gridSocket || gridDevicePort === null) {
    _event(`gridSysSend failed: socket=${!!gridSocket} port=${gridDevicePort}`);
    return;
  }
  _event(`gridSysSend → port ${gridDevicePort}: ${address} [${args.join(", ")}]`);
  const msg = oscMessage(address, typeTags, ...args);
  gridSocket.send(msg, { transport: "udp", hostname: gridDeviceHost, port: gridDevicePort });
}

function gridLed(x: number, y: number, level: number): void {
  gridSend("/grid/led/level/set", "iii", x, y, level);
}

// --- Arc communication ---

function arcSend(address: string, typeTag: string, ...args: (string | number)[]): void {
  if (!gridSocket || arcDevicePort === null) return;
  const msg = oscMessage(ARC_PREFIX + address, typeTag, ...args);
  gridSocket.send(msg, { transport: "udp", hostname: "127.0.0.1", port: arcDevicePort });
  _event(`arcSend → port ${arcDevicePort}: ${address} [${args.join(", ")}]`);
}

function arcSysSend(address: string, typeTag: string, ...args: (string | number)[]): void {
  if (!gridSocket || arcDevicePort === null) return;
  const msg = oscMessage(address, typeTag, ...args);
  gridSocket.send(msg, { transport: "udp", hostname: "127.0.0.1", port: arcDevicePort });
  _event(`arcSysSend → port ${arcDevicePort}: ${address} [${args.join(", ")}]`);
}

// --- Grid region lookup and rendering ---

function findGridRegion(x: number, y: number): GridRegion | null {
  for (const region of gridRegions.values()) {
    if (x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h) {
      return region;
    }
  }
  return null;
}

export function rebuildGridRegions(): void {
  gridRegions.clear();
  arcEncoders.clear();
  gridArrayStates.clear();
  gridToggleStates.clear();

  for (const [boxId, box] of boxes) {
    const type = _boxTypeName(box.text);

    // Grid regions
    // grid-trig / grid-toggle: `x y` — always 1×1
    // grid-array:              `x y w h` — width/height configurable
    if (type === "grid-trig" || type === "grid-toggle" || type === "grid-array") {
      const args = box.text.split(/\s+/).slice(1).map(Number);
      const needed = type === "grid-array" ? 4 : 2;
      if (args.length >= needed) {
        const w = type === "grid-array" ? args[2] : 1;
        const h = type === "grid-array" ? args[3] : 1;
        gridRegions.set(boxId, {
          boxId,
          x: args[0],
          y: args[1],
          w,
          h,
          type: type as "grid-trig" | "grid-toggle" | "grid-array",
        });
        _event(`registered ${type} region: box ${boxId} at (${args[0]},${args[1]}) size ${w}×${h}`);
        if (type === "grid-toggle") {
          gridToggleStates.set(boxId, false);
          _setBoxValueAndNotify(boxId, 0);
        }
        if (type === "grid-array") {
          gridArrayStates.set(boxId, { array: [1], heldButtons: new Set(), rangeGestureActive: false });
          _setBoxValueAndNotify(boxId, [1]);
        }
      }
    }

    // Arc encoders
    if (type === "arc") {
      const args = box.text.split(/\s+/).slice(1).map(Number);
      if (args.length >= 1) {
        const encoder = args[0];
        const mode = args[1] || 0;
        arcEncoders.set(boxId, { boxId, encoder, mode });
        _event(`registered arc encoder: box ${boxId} enc ${encoder} mode ${mode}`);
        if (!arcValues.has(boxId)) {
          const init = args[2] !== undefined && !isNaN(args[2]) ? args[2] : 0.5;
          arcValues.set(boxId, init);
        }
      }
    }
  }

  // Render all grid regions and arc encoders after registration
  if (gridDevicePort !== null) {
    for (const region of gridRegions.values()) {
      renderGridRegion(region);
    }
  }
  if (arcReady) {
    renderAllArcEncoders();
  }
}

// --- Grid key handlers ---

function handleGridKey(x: number, y: number, pressed: boolean): void {
  const region = findGridRegion(x, y);
  if (!region) {
    _event(`grid key (${x},${y}): no region found`);
    return;
  }

  _event(`grid key (${x},${y}) ${pressed ? "down" : "up"} → ${region.type} box ${region.boxId}`);

  if (region.type === "grid-trig") {
    handleGridTrig(region, pressed);
  } else if (region.type === "grid-toggle") {
    handleGridToggle(region, x, y, pressed);
  } else if (region.type === "grid-array") {
    handleGridArray(region, x, y, pressed);
  }
}

function handleGridTrig(region: GridRegion, pressed: boolean): void {
  _setBoxValueAndNotify(region.boxId, pressed ? 1 : 0);
  renderGridRegion(region);
}

function handleGridToggle(region: GridRegion, _x: number, _y: number, pressed: boolean): void {
  if (!pressed) return;

  const currentState = gridToggleStates.get(region.boxId) || false;
  const newState = !currentState;
  gridToggleStates.set(region.boxId, newState);
  _setBoxValueAndNotify(region.boxId, newState ? 1 : 0);
  renderGridRegion(region);
}

function ensureNonEmpty(arr: number[]): number[] {
  if (arr.length === 0) arr.push(1);
  return arr;
}

function handleGridArray(region: GridRegion, x: number, _y: number, pressed: boolean): void {
  const state = gridArrayStates.get(region.boxId);
  if (!state) return;

  const relativeX = x - region.x;
  const value = relativeX + 1;

  if (pressed) {
    _event(`grid-array: press value=${value}, heldButtons=[${Array.from(state.heldButtons).join(",")}], array=[${state.array.join(",")}]`);

    if (state.heldButtons.size > 0) {
      state.rangeGestureActive = true;
      const firstX = Array.from(state.heldButtons)[0];
      const firstValue = firstX + 1;
      const firstActive = state.array.includes(firstValue);

      const minVal = Math.min(value, firstValue);
      const maxVal = Math.max(value, firstValue);

      if (firstActive) {
        _event(`grid-array: CLEAR range [${minVal}..${maxVal}]`);
        for (let v = minVal; v <= maxVal; v++) {
          const idx = state.array.indexOf(v);
          if (idx !== -1) state.array.splice(idx, 1);
        }
      } else {
        _event(`grid-array: FILL range [${minVal}..${maxVal}]`);
        for (let v = minVal; v <= maxVal; v++) {
          if (!state.array.includes(v)) state.array.push(v);
        }
      }
      state.array.sort((a, b) => a - b);
      ensureNonEmpty(state.array);
      _setBoxValueAndNotify(region.boxId, state.array);
    }

    state.heldButtons.add(relativeX);
  } else {
    state.heldButtons.delete(relativeX);

    if (state.heldButtons.size === 0) {
      if (!state.rangeGestureActive) {
        _event(`grid-array: single toggle value=${value}`);
        const idx = state.array.indexOf(value);
        if (idx !== -1) {
          state.array.splice(idx, 1);
        } else {
          state.array.push(value);
        }
        state.array.sort((a, b) => a - b);
        ensureNonEmpty(state.array);
        _setBoxValueAndNotify(region.boxId, state.array);
      }
      state.rangeGestureActive = false;
    }
  }

  renderGridRegion(region);
}

// --- Rendering ---

function renderGridRegion(region: GridRegion): void {
  if (region.type === "grid-trig") {
    const raw = boxValues.get(region.boxId) || 0;
    const level = (typeof raw === "number" && raw > 0) ? 15 : 0;
    _event(`grid-trig LED: region (${region.x},${region.y}) level=${level}`);
    for (let dy = 0; dy < region.h; dy++) {
      for (let dx = 0; dx < region.w; dx++) {
        gridLed(region.x + dx, region.y + dy, level);
      }
    }
  } else if (region.type === "grid-toggle") {
    const state = gridToggleStates.get(region.boxId) || false;
    const level = state ? 15 : 0;
    for (let dy = 0; dy < region.h; dy++) {
      for (let dx = 0; dx < region.w; dx++) {
        gridLed(region.x + dx, region.y + dy, level);
      }
    }
  } else if (region.type === "grid-array") {
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

function handleArcDelta(encoder: number, delta: number): void {
  if (encoder < 0 || encoder > 3) return;

  for (const [boxId, arcEnc] of arcEncoders.entries()) {
    if (arcEnc.encoder === encoder) {
      const currentValue = arcValues.get(boxId) ?? 0.5;
      const newValue = Math.max(0, Math.min(1, currentValue + delta * ARC_SENSITIVITY));
      arcValues.set(boxId, newValue);
      _setBoxValueAndNotify(boxId, newValue);
      renderArcEncoder(encoder);
    }
  }
}

function renderArcEncoder(encoder: number): void {
  if (arcDevicePort === null) return;

  for (const [boxId, arcEnc] of arcEncoders.entries()) {
    if (arcEnc.encoder === encoder) {
      const value = arcValues.get(boxId) ?? 0.5;

      const numLeds = Math.floor(value * 64);
      const ledData: number[] = new Array(64).fill(0);

      for (let i = 0; i < numLeds; i++) {
        const ledIndex = (32 + i) % 64;
        ledData[ledIndex] = 15;
      }

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

// --- Device info for ctrl client sync ---

export function getGridDeviceInfo(): { deviceType: string; deviceId: string } | null {
  return gridDeviceInfo;
}

export function getArcDeviceInfo(): { deviceType: string; deviceId: string } | null {
  return arcDeviceInfo;
}

// --- serialosc initialization and device discovery ---

export async function initGrid(): Promise<void> {
  try {
    gridSocket = Deno.listenDatagram({ port: GRID_LISTEN_PORT, transport: "udp", hostname: "127.0.0.1" });
    _event(`grid listener on port ${GRID_LISTEN_PORT}`);

    async function resubscribeNotify() {
      const msg = oscMessage("/serialosc/notify", "si", "127.0.0.1", GRID_LISTEN_PORT);
      const conn = Deno.listenDatagram({ port: 0, transport: "udp", hostname: "127.0.0.1" });
      await conn.send(msg, { transport: "udp", hostname: "127.0.0.1", port: SERIALOSC_PORT });
      conn.close();
    }
    await resubscribeNotify();

    const discoveryMsg = oscMessage("/serialosc/list", "si", "127.0.0.1", GRID_LISTEN_PORT);
    const serialoscConn = Deno.listenDatagram({ port: 0, transport: "udp", hostname: "127.0.0.1" });
    await serialoscConn.send(discoveryMsg, { transport: "udp", hostname: "127.0.0.1", port: SERIALOSC_PORT });
    serialoscConn.close();

    (async () => {
      for await (const [data, addr] of gridSocket!) {
        const msg = parseOsc(new Uint8Array(data));
        if (!msg) {
          _event(`grid OSC: failed to parse message`);
          continue;
        }

        if (!["/sys/port", "/sys/host", "/sys/prefix"].includes(msg.address)) {
          _event(`grid OSC: ${msg.address} [${msg.args.join(", ")}]`);
        }

        // Fallback: if /serialosc/add was missed (e.g. server started against an
        // already-connected grid and serialosc's subscription cache skipped us),
        // adopt the source port of any grid-addressed message as gridDevicePort.
        // Keys from serialosc arrive via the per-grid proxy — that proxy's port
        // is exactly what we need for sending LEDs back.
        if (gridDevicePort === null && msg.address.startsWith(GRID_PREFIX + "/")) {
          const srcPort = (addr as Deno.NetAddr).port;
          _event(`grid port adopted from incoming message: ${srcPort}`);
          gridDevicePort = srcPort;
          gridSysSend("/sys/prefix", "s", GRID_PREFIX);
          gridSend("/grid/led/all", "i", 0);
          for (const region of gridRegions.values()) renderGridRegion(region);
        }

        if (msg.address === "/serialosc/device" || msg.address === "/serialosc/add") {
          const [deviceId, deviceType, devicePort] = msg.args;
          const devTypeStr = deviceType as string;
          const devPortNum = devicePort as number;
          const devIdStr = deviceId as string;

          if (devTypeStr.includes("arc")) {
            if (arcDeviceInfo && arcDeviceInfo.deviceId === devIdStr) continue;
            _event(`arc detected: ${devTypeStr} (${devIdStr}) on port ${devPortNum}`);
            arcDevicePort = devPortNum;
            arcDeviceInfo = { deviceType: devTypeStr, deviceId: devIdStr };

            arcSysSend("/sys/port", "i", GRID_LISTEN_PORT);
            arcSysSend("/sys/host", "s", "127.0.0.1");
            arcSysSend("/sys/prefix", "s", ARC_PREFIX);

            for (let i = 0; i < 4; i++) {
              arcSend("/ring/all", "ii", i, 0);
            }

            arcReady = true;
            renderAllArcEncoders();

            _sendCtrl({ type: "arc-connected", deviceType: devTypeStr, deviceId: devIdStr });
          } else {
            if (gridDeviceInfo && gridDeviceInfo.deviceId === devIdStr) continue;
            _event(`grid detected: ${devTypeStr} (${devIdStr}) on port ${devPortNum}`);
            gridDevicePort = devPortNum;
            gridDeviceInfo = { deviceType: devTypeStr, deviceId: devIdStr };

            gridSysSend("/sys/port", "i", GRID_LISTEN_PORT);
            gridSysSend("/sys/host", "s", "127.0.0.1");
            gridSysSend("/sys/prefix", "s", GRID_PREFIX);
            gridSend("/grid/led/all", "i", 0);

            for (const region of gridRegions.values()) {
              renderGridRegion(region);
            }

            _sendCtrl({ type: "grid-connected", deviceType: gridDeviceInfo.deviceType, deviceId: gridDeviceInfo.deviceId });
          }
          await resubscribeNotify();
        }

        if (msg.address === "/serialosc/remove") {
          const [deviceId, deviceType] = msg.args;
          const devTypeStr = deviceType as string;

          if (devTypeStr.includes("arc")) {
            if (arcDeviceInfo) {
              _event(`arc removed: ${devTypeStr} (${deviceId})`);
              _sendCtrl({ type: "arc-disconnected", deviceType: devTypeStr, deviceId: deviceId as string });
              arcDeviceInfo = null;
              arcReady = false;
            }
          } else {
            if (gridDeviceInfo) {
              _event(`grid removed: ${devTypeStr} (${deviceId})`);
              _sendCtrl({ type: "grid-disconnected", deviceType: devTypeStr, deviceId: deviceId as string });
              gridDeviceInfo = null;
            }
          }
          await resubscribeNotify();
        }

        if (msg.address === "/sys/disconnect" || msg.address === "/sys/connect") {
          continue;
        }

        if (msg.address === GRID_PREFIX + "/grid/key") {
          const [x, y, state] = msg.args as number[];
          handleGridKey(x, y, state === 1);
        }

        if (msg.address === ARC_PREFIX + "/enc/delta") {
          const [encoder, delta] = msg.args as number[];
          _event(`arc enc ${encoder} delta ${delta}`);
          handleArcDelta(encoder, delta);
        }
      }
    })();
  } catch (e) {
    console.error("Failed to init grid:", e);
  }
}
