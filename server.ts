const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";
const HTTPS_PORT = 8443;
const HTTP_PORT = 8080;
const HOST_IP = Deno.env.get("HOST_IP") || "192.168.178.10";
const HOST_DOMAIN = Deno.env.get("HOST_DOMAIN") || "local.assembly.fm";

// --- Import shared box types ---

// deno-lint-ignore no-explicit-any
const gpiTypes: any = {};
const gpiSrc = await Deno.readTextFile("./public/gpi-types.js");
// Strip the ES module export line so we can evaluate as CJS
const gpiSrcCjs = gpiSrc.replace(/^export\s+\{[^}]*\};?\s*$/m, "");
const gpiModule = new Function("exports", gpiSrcCjs);
gpiModule(gpiTypes);
const { BOX_TYPES, boxTypeName, getBoxPorts, getBoxZone, getBoxDef } = gpiTypes;

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
    return new Response(body, { headers: { "content-type": mimeType(path) } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// --- Client tracking ---

let nextClientId = 1;
const synthWsClients = new Map<number, WebSocket>();
type SSESend = (data: Record<string, unknown>) => void;
const sseClients = new Map<number, SSESend>();
const gpiSockets = new Set<WebSocket>();

function totalSynthClients(): number { return synthWsClients.size + sseClients.size; }

function broadcastSynth(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const [, socket] of synthWsClients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
  for (const [, send] of sseClients) send(msg);
}

function sendGPI(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const socket of gpiSockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

function broadcastClientCount(): void {
  const count = totalSynthClients();
  broadcastSynth({ type: "count", clients: count });
  sendGPI({ type: "count", clients: count });
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
    default: return a;
  }
}

function propagate(boxId: number, outletIndex: number, value: number): void {
  for (const cable of cablesFromOutlet(boxId, outletIndex)) {
    const dst = boxes.get(cable.dstBox);
    if (!dst) continue;
    const def = getBoxDef(dst.text);
    if (!def) continue;
    if (def.zone === "router") {
      // send rv to synth clients
      const msg = { type: "rv", r: cable.dstBox, ch: cable.dstInlet, v: value };
      latestValues.set(cable.dstBox + ":" + cable.dstInlet, JSON.stringify(msg));
      broadcastSynth(msg);
    } else if (def.zone !== "synth") {
      // ctrl-side or any-zone box above border: evaluate
      let iv = inletValues.get(cable.dstBox);
      if (!iv) { iv = []; inletValues.set(cable.dstBox, iv); }
      iv[cable.dstInlet] = value;
      const result = evaluateBox(dst, iv);
      boxValues.set(cable.dstBox, result);
      const outlets = def.outlets?.length || 1;
      for (let i = 0; i < outlets; i++) propagate(cable.dstBox, i, result);
    }
  }
}

function setBoxValue(boxId: number, value: number): void {
  boxValues.set(boxId, value);
  const box = boxes.get(boxId);
  if (!box) return;
  const def = getBoxDef(box.text);
  const outlets = def ? def.outlets.length : 1;
  for (let i = 0; i < outlets; i++) propagate(boxId, i, value);
}

function evaluateConstBoxes(): void {
  for (const [id, box] of boxes) {
    if (boxTypeName(box.text) === "const") setBoxValue(id, parseFloat(box.text.split(/\s+/)[1]) || 0);
  }
}

// --- Batched value updates to GPI at ~30fps ---

let pendingValueUpdates = new Map<number, number>();

function queueValueUpdate(id: number, value: number): void {
  pendingValueUpdates.set(id, value);
}

setInterval(() => {
  if (pendingValueUpdates.size === 0) return;
  const updates: Array<{ id: number; value: number }> = [];
  for (const [id, value] of pendingValueUpdates) updates.push({ id, value });
  pendingValueUpdates = new Map();
  sendGPI({ type: "values", updates });
}, 33);

// Hook into setBoxValue to queue display updates
const _origSetBoxValue = setBoxValue;
// We can't reassign a function declaration, so we wrap propagate instead
const _origPropagate = propagate;

// Override: after any boxValue changes, queue the update
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
    if (prev < ONSET_THRESHOLD && value >= ONSET_THRESHOLD) propagateAndNotify(boxId, 1, value);
    if (prev >= ONSET_THRESHOLD && value < ONSET_THRESHOLD) propagateAndNotify(boxId, 2, value);
    return;
  }

  const outlets = def.outlets.length || 1;
  for (let i = 0; i < outlets; i++) propagateAndNotify(boxId, i, value);
}

function propagateAndNotify(boxId: number, outletIndex: number, value: number): void {
  for (const cable of cablesFromOutlet(boxId, outletIndex)) {
    const dst = boxes.get(cable.dstBox);
    if (!dst) continue;
    const def = getBoxDef(dst.text);
    if (!def) continue;
    if (def.zone === "router") {
      const msg = { type: "rv", r: cable.dstBox, ch: cable.dstInlet, v: value };
      latestValues.set(cable.dstBox + ":" + cable.dstInlet, JSON.stringify(msg));
      broadcastSynth(msg);
    } else if (def.zone !== "synth" && !(def.zone === "any" && isSynthZone(dst.x, dst.y))) {
      // check if this inlet is an event/trigger type — fire event handler
      const inletDef = def.inlets[cable.dstInlet];
      if (inletDef && inletDef.type === "event" && boxState.has(cable.dstBox)) {
        handleEventBox(cable.dstBox, value);
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

function initBoxState(id: number, box: Box): void {
  const name = boxTypeName(box.text);
  const args = box.text.split(/\s+/).slice(1);
  switch (name) {
    case "phasor":
      boxState.set(id, { phase: 0, period: parseFloat(args[0]) || 1, paused: false });
      break;
    case "metro":
      boxState.set(id, { elapsed: 0, interval: parseFloat(args[0]) || 1 });
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
          state.phase -= 1;
          // end-of-cycle event on outlet 1
          propagateAndNotify(id, 1, 0);
        }
        setBoxValueAndNotify(id, state.phase);
        break;
      }
      case "metro": {
        state.elapsed += TICK_DT;
        if (state.elapsed >= state.interval) {
          state.elapsed -= state.interval;
          // fire event through outlet 0
          propagateAndNotify(id, 0, 1);
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
    // inlet 0 = pause, inlet 2 = period
    if (inlet === 0) { state.paused = value > 0; return true; }
    if (inlet === 2) { state.period = Math.max(0.001, value); return true; }
  }
  if (name === "metro") {
    // metro could accept interval changes on inlet 0
    // (not defined yet, but future-proof)
  }
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
      // reset event on inlet 1
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

// --- Apply (replaces entire graph state from GPI) ---

// deno-lint-ignore no-explicit-any
function handleApply(msg: any): void {
  boxes.clear(); cables.clear(); boxValues.clear(); inletValues.clear(); boxState.clear();
  for (const [id, box] of msg.boxes) {
    const p = getBoxPorts(box.text);
    box.inlets = p.inlets; box.outlets = p.outlets;
    boxes.set(id, box);
  }
  for (const [id, cable] of msg.cables) cables.set(id, cable);
  patchNextId = msg.nextId || 1;
  if (msg.synthBorderY !== undefined) synthBorderY = msg.synthBorderY;

  // rebuild ctrl evaluation
  initAllBoxState();
  evaluateAllConsts();

  // deploy synth patch to clients
  deployPatch();

  // confirm to GPI
  sendGPI({ type: "applied" });

  console.log("Patch applied");
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
      break;
    }
    case "box-delete": {
      for (const id of msg.ids) { removeCablesForBox(id); boxes.delete(id); boxValues.delete(id); inletValues.delete(id); boxState.delete(id); }
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
  console.log("Patch deployed");
  sendGPI({ type: "deployed" });
  // re-evaluate consts so rv messages flow immediately after deploy
  evaluateAllConsts();
}

// --- Full state sync for GPI ---

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
  sendGPI(getFullState());
}

// --- GPI WebSocket handler ---

function handleGpiWs(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.addEventListener("open", () => {
    gpiSockets.add(socket);
    console.log(`GPI connected (${gpiSockets.size} total)`);
    socket.send(JSON.stringify(getFullState()));
    socket.send(JSON.stringify({ type: "count", clients: totalSynthClients() }));
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
      } else if (msg.type === "health") {
        socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
      }
    } catch { /* ignore malformed */ }
  });

  socket.addEventListener("close", () => {
    gpiSockets.delete(socket);
    console.log(`GPI disconnected (${gpiSockets.size} total)`);
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
    console.log(`Synth WS ${id} connected from ${clientIP} (${totalSynthClients()} total)`);
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
    } catch { /* ignore malformed */ }
  });

  socket.addEventListener("close", () => {
    synthWsClients.delete(id);
    trackDisconnect(clientIP, id);
    console.log(`Synth WS ${id} disconnected (${totalSynthClients()} total)`);
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
      console.log(`SSE ${id} connected from ${clientIP} (${totalSynthClients()} total)`);
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
      console.log(`SSE ${id} disconnected (${totalSynthClients()} total)`);
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
    console.log(`CNA: redirecting ${clientIP} to HTTPS via ${url.pathname}`);
    return Response.redirect(`https://${HOST_DOMAIN}:${HTTPS_PORT}`, 302);
  }

  if (url.pathname === "/auth") { authenticatedIPs.add(clientIP); return new Response("ok"); }
  if (url.pathname === "/events") return handleSSE(req, info);
  // route WebSocket by path
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (url.pathname === "/ws/gpi") return handleGpiWs(req);
    return handleSynthWs(req, info);
  }
  const ext = url.pathname.split(".").pop()?.toLowerCase();
  if (ext && ["js", "css", "json", "png", "ico"].includes(ext)) return serveFile(url.pathname);
  return serveFile("/index.html");
}

// --- Patch storage API ---

const PATCHES_DIR = "./patches";
await Deno.mkdir(PATCHES_DIR, { recursive: true });

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
    console.log(`Patch saved: ${name}`);
    return new Response(JSON.stringify({ ok: true, name }), { headers });
  }

  // DELETE /patches/name — delete a patch
  if (req.method === "DELETE" && url.pathname.startsWith("/patches/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(9)));
    if (!name) return new Response("Invalid name", { status: 400 });
    try {
      await Deno.remove(`${PATCHES_DIR}/${name}.json`);
      console.log(`Patch deleted: ${name}`);
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
    if (url.pathname === "/ws/gpi") return handleGpiWs(req);
    return handleSynthWs(req, info);
  }
  if (url.pathname === "/events") return handleSSE(req, info);
  if (url.pathname === "/auth") { authenticatedIPs.add((info.remoteAddr as Deno.NetAddr).hostname); return new Response("ok"); }
  if (url.pathname.startsWith("/patches")) return handlePatchAPI(req, url);
  return serveFile(url.pathname === "/" ? "/index.html" : url.pathname);
}

// --- Start ---

const tlsAvailable = await hasCerts();
console.log(`HOST_IP: ${HOST_IP}`);

if (tlsAvailable) {
  console.log("TLS certs found — starting HTTPS + HTTP portal");
  console.log(`Synth:  https://localhost:${HTTPS_PORT}/`);
  console.log(`Ctrl:   https://localhost:${HTTPS_PORT}/ctrl.html`);
  Deno.serve({ port: HTTP_PORT, hostname: "0.0.0.0" }, (req, info) => portalHandler(req, info));
  Deno.serve({ port: HTTPS_PORT, cert: await Deno.readTextFile(CERT_FILE), key: await Deno.readTextFile(KEY_FILE) }, (req, info) => httpsHandler(req, info));
} else {
  console.log("No TLS certs — dev mode (HTTP only)");
  console.log(`Synth:  http://localhost:${HTTP_PORT}/`);
  console.log(`Ctrl:   http://localhost:${HTTP_PORT}/ctrl.html`);
  Deno.serve({ port: HTTP_PORT, hostname: "0.0.0.0" }, (req, info) => httpsHandler(req, info));
}

setInterval(() => {
  broadcastSynth({ type: "health", ts: Date.now() });
  for (const socket of gpiSockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
  }
}, 5000);
