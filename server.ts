import {
  type Box, type Cable, type BoxValue,
  boxes, cables, boxValues, inletValues, boxState,
  getPatchNextId, setPatchNextId, bumpPatchNextId,
  getSynthBorderY, setSynthBorderY,
  getDeployedPatch, setDeployedPatch,
  routerState, groupState, latestValues, uplinkIndex,
  clearPatchState, removeCablesForBox, cablesFromOutlet, isSynthZone,
} from "./patch-state.ts";
import { initHardware, initGrid, rebuildGridRegions, arcValues, getGridDeviceInfo, getArcDeviceInfo } from "./hardware.ts";
import {
  initEvalEngine, buildGroups,
  setBoxValueAndNotify, propagateAndNotify,
  evaluateAllConsts, evaluateAllDevices, evaluateAllClients,
  initBoxState, shouldServerEval, initAllBoxState,
  findBoxByText, CC_SOURCE, queueValueUpdate,
} from "./eval-engine.ts";
import { getLanIP, qrText } from "./onboarding.ts";

const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";
// Workshop self-signed cert — distinct filenames so generation can never
// clobber the real Let's Encrypt cert.pem/key.pem (reserved for performance).
const SELF_CERT_FILE = "cert.selfsigned.pem";
const SELF_KEY_FILE = "key.selfsigned.pem";
const HOST_IP = Deno.env.get("HOST_IP") || "192.168.178.24";
const HOST_DOMAIN = Deno.env.get("HOST_DOMAIN") || "local.assembly.fm";
// WiFi creds for the join QR / banner (defaults match the performance rig).
const WIFI_SSID = Deno.env.get("WIFI_SSID") || "assembly";
const WIFI_PASSWORD = Deno.env.get("WIFI_PASSWORD") ?? "assembly";

// --- Run mode ---
// One explicit switch drives bind host, ports, cert policy, captive portal and
// dnsmasq expectations. Tracks *who the audience is*, not where it runs.
// See notes/network-and-modes.md.
type CertKind = "none" | "self-signed" | "letsencrypt";
interface ModeConfig {
  bindHost: string;          // "127.0.0.1" (laptop only) | "0.0.0.0" (LAN)
  appPort: number;           // 8443 (unprivileged) | 443
  portalPort: number | null; // captive-portal HTTP listener, or null
  needsCaptivePortal: boolean;
  certKind: CertKind;
  needsDnsmasqWarning: boolean;
  needsStaticIP: boolean;    // informational; enforced in start-macos.sh
}
const MODES: Record<string, ModeConfig> = {
  practice:    { bindHost: "127.0.0.1", appPort: 8443, portalPort: null, needsCaptivePortal: false, certKind: "none",        needsDnsmasqWarning: false, needsStaticIP: false },
  workshop:    { bindHost: "0.0.0.0",   appPort: 8443, portalPort: null, needsCaptivePortal: false, certKind: "self-signed", needsDnsmasqWarning: false, needsStaticIP: false },
  performance: { bindHost: "0.0.0.0",   appPort: 443,  portalPort: 80,   needsCaptivePortal: true,  certKind: "letsencrypt", needsDnsmasqWarning: true,  needsStaticIP: true  },
};
const MODE = Deno.env.get("MODE") ?? "practice";
const cfg = MODES[MODE];
if (!cfg) {
  console.error(`\x1b[31m✗ Unknown MODE "${MODE}". Valid modes: ${Object.keys(MODES).join(", ")}\x1b[0m`);
  Deno.exit(1);
}


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

// --- Import shared modules ---

// deno-lint-ignore no-explicit-any
function importCjs(src: string): any {
  const obj: Record<string, unknown> = {};
  const cjs = src.replace(/^export\s+\{[^}]*\};?\s*$/m, "");
  new Function("exports", cjs)(obj);
  return obj;
}

const boxTypes = importCjs(await Deno.readTextFile("./public/gpi-types.js"));
const { BOX_TYPES, boxTypeName, getBoxPorts, getBoxZone, getBoxDef, isAudioBox, isDac } = boxTypes;

const graphCore = importCjs(await Deno.readTextFile("./public/graph-core.js"));
const { createBoxState, evaluatePure, handleBoxEvent, tickBox, isEventTrigger, expandIntegerNotation, applyInletToState, deliverValueToInlet } = graphCore;

// Wire module callbacks (function declarations are hoisted, safe to reference here)
initEvalEngine({
  broadcastSynth, sendToClient, getSynthClientIds, sendCtrl, event,
  boxTypeName, getBoxDef, getBoxZone, isAudioBox,
  evaluatePure, createBoxState, tickBox, handleBoxEvent, applyInletToState,
  deliverValueToInlet,
});
initHardware({ setBoxValueAndNotify, sendCtrl, event, boxTypeName, getBoxDef });

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
    flac: "audio/flac", wav: "audio/wav", aiff: "audio/aiff", aif: "audio/aiff",
    ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4",
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


// Router state, evaluation engine, and tick loop imported from eval-engine.ts

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
  // Rebuild group router memberships when client count changes
  for (const boxId of groupState.keys()) buildGroups(boxId);
  // Push the new count to every patch-side `clients` box
  evaluateAllClients();
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

// --- Edit handling ---

// --- Abstraction expansion ---

function expandAbstractions(): string[] {
  const errors: string[] = [];
  const MAX_DEPTH = 16;
  let globalIdCounter = 100000;
  let nextCableId = getPatchNextId() + 50000;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let expanded = 0;

    for (const [boxId, box] of [...boxes]) {
      const absName = boxTypeName(box.text);
      const absDef = loadedAbstractions.get(absName);
      if (!absDef) continue;

      // Parse arguments: "scale-note 48 7" → args = ["48", "7"]
      const args = box.text.split(/\s+/).slice(1);
      const instanceId = String(globalIdCounter);  // $0

      // Build inlet/outlet index → internal box mapping
      const inletMap = new Map<number, number>();
      const outletMap = new Map<number, number>();

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

        const globalId = globalIdCounter++;
        localToGlobal.set(localId, globalId);

        // Argument substitution: $0=instanceId, $1=args[0], $2=args[1], ...
        let text = intBox.text;
        text = text.replace(/\$0/g, instanceId);
        for (let i = 0; i < args.length; i++) {
          text = text.replace(new RegExp("\\$" + (i + 1), "g"), args[i]);
        }

        // Zone inheritance: cloned boxes get Y of instance box
        const clonedBox = { ...intBox, text, x: intBox.x, y: box.y };
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
          srcBox: srcGlobal, srcOutlet: cable.srcOutlet,
          dstBox: dstGlobal, dstInlet: cable.dstInlet,
        });
      }

      // Rewire external cables through inlet/outlet
      for (const [cableId, cable] of [...cables]) {
        if (cable.dstBox === boxId) {
          const inletLocalId = inletMap.get(cable.dstInlet);
          if (inletLocalId === undefined) {
            errors.push(`${absName}: cable targets inlet ${cable.dstInlet}, but only inlets 0-${inletMap.size - 1} exist`);
            cables.delete(cableId);
            continue;
          }
          for (const [, intCable] of absDef.cables) {
            if (intCable.srcBox === inletLocalId) {
              const targetGlobal = localToGlobal.get(intCable.dstBox);
              if (targetGlobal !== undefined) {
                cables.set(nextCableId++, {
                  srcBox: cable.srcBox, srcOutlet: cable.srcOutlet,
                  dstBox: targetGlobal, dstInlet: intCable.dstInlet,
                });
              }
            }
          }
          cables.delete(cableId);
        }

        if (cable.srcBox === boxId) {
          const outletLocalId = outletMap.get(cable.srcOutlet);
          if (outletLocalId === undefined) {
            errors.push(`${absName}: cable from outlet ${cable.srcOutlet}, but only outlets 0-${outletMap.size - 1} exist`);
            cables.delete(cableId);
            continue;
          }
          for (const [, intCable] of absDef.cables) {
            if (intCable.dstBox === outletLocalId) {
              const sourceGlobal = localToGlobal.get(intCable.srcBox);
              if (sourceGlobal !== undefined) {
                cables.set(nextCableId++, {
                  srcBox: sourceGlobal, srcOutlet: intCable.srcOutlet,
                  dstBox: cable.dstBox, dstInlet: cable.dstInlet,
                });
              }
            }
          }
          cables.delete(cableId);
        }
      }

      boxes.delete(boxId);
      expanded++;
    }

    if (expanded === 0) break;

    // Cycle detection: check if any remaining abstraction was just expanded
    if (depth === MAX_DEPTH - 1) {
      errors.push("Abstraction nesting limit reached (16 levels) — possible circular reference");
    }
  }

  return errors;
}

// --- Apply (replaces entire graph state from ctrl) ---

// deno-lint-ignore no-explicit-any
function handleApply(msg: any): void {
  clearPatchState();
  for (const [id, box] of msg.boxes) {
    const p = getBoxPorts(box.text);
    box.inlets = p.inlets; box.outlets = p.outlets;
    boxes.set(id, box);
    // snap routers to border
    if (getBoxZone(box.text) === "router") {
      box.y = getSynthBorderY() - 11;
    }
  }
  for (const [id, cable] of msg.cables) cables.set(id, cable);
  setPatchNextId(msg.nextId || 1);
  if (msg.synthBorderY !== undefined) setSynthBorderY(msg.synthBorderY);

  // expand abstractions inline
  const absErrors = expandAbstractions();
  if (absErrors.length > 0) {
    for (const err of absErrors) console.log(`\x1b[33m⚠ ${err}\x1b[0m`);
    sendCtrl({ type: "errors", errors: absErrors });
  }

  // rebuild ctrl evaluation
  initAllBoxState();
  rebuildGridRegions();
  evaluateAllConsts();
  evaluateAllDevices();
  evaluateAllClients();

  // deploy synth patch to clients
  deployPatch();

  // confirm to ctrl — triggers audio rebuild on ctrl client
  sendCtrl({ type: "applied" });
  // re-evaluate consts AFTER "applied" so ctrl-audio-param messages
  // arrive after the ctrl client has rebuilt its audio graph
  evaluateAllConsts();
  evaluateAllDevices();
  evaluateAllClients();
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
      bumpPatchNextId(msg.id);
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
      if (getBoxZone(msg.text) === "router") box.y = getSynthBorderY() - 11;
      // zone enforcement
      const zone = getBoxZone(msg.text);
      if (zone === "synth" && !isSynthZone(box.x, box.y)) box.y = getSynthBorderY() + 20;
      else if (zone === "ctrl" && isSynthZone(box.x, box.y)) box.y = getSynthBorderY() - 42;
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
      bumpPatchNextId(msg.id);
      evaluateAllConsts();
      break;
    }
    case "cable-delete": {
      for (const id of msg.ids) cables.delete(id);
      break;
    }
    case "border-move": {
      setSynthBorderY(msg.y);
      // snap all routers
      for (const [, box] of boxes) if (getBoxZone(box.text) === "router") box.y = getSynthBorderY() - 11;
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
    const synth = def.zone === "synth" || (def.zone === "any" && isSynthZone(box.x, box.y));
    if (synth) {
      synthIds.add(id);
      const name = boxTypeName(box.text), args = box.text.split(/\s+/).slice(1).join(" ");
      // deno-lint-ignore no-explicit-any
      const pb: any = { id, type: name, args };
      if (isDac(box.text)) pb.dac = true;
      // Any audio box with number inlets needs paramNames for the synth client
      if (isAudioBox(box.text)) {
        pb.engine = true;
        pb.paramNames = def.inlets.map((i: { name: string; type: string }) => i.type === "audio" ? null : i.name);
      }
      patchBoxes.push(pb);
    }
  }

  // Separate audio cables from control cables
  // deno-lint-ignore no-explicit-any
  const audioCables: any[] = [];
  for (const [, c] of cables) {
    if (!synthIds.has(c.srcBox) || !synthIds.has(c.dstBox)) continue;
    const srcBox = boxes.get(c.srcBox);
    const srcDef = srcBox ? getBoxDef(srcBox.text) : null;
    const srcOutlet = srcDef?.outlets?.[c.srcOutlet];
    if (srcOutlet?.type === "audio") {
      audioCables.push({ srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet });
    } else {
      patchCables.push({ srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet });
    }
  }

  for (const [id, box] of boxes) {
    const def = getBoxDef(box.text);
    if (!def || def.zone !== "router") continue;
    if (boxTypeName(box.text) === "sall") {
      // sall: match synth-side r/receive boxes by name (multi-name: each name maps to a channel)
      const names = box.text.split(/\s+/).slice(1);
      for (let ch = 0; ch < names.length; ch++) {
        const name = names[ch];
        if (!name) continue;
        for (const [recvId, recvBox] of boxes) {
          if (!synthIds.has(recvId)) continue;
          const recvType = boxTypeName(recvBox.text);
          if ((recvType === "r" || recvType === "receive") && recvBox.text.split(/\s+/).slice(1).join(" ") === name) {
            entries.push({ routerId: id, routerOutlet: ch, targetBox: recvId, targetInlet: 0 });
          }
        }
      }
      continue;
    }
    const channels = box.outlets || 1;
    for (let ch = 0; ch < channels; ch++) {
      for (const c of cablesFromOutlet(id, ch)) {
        if (synthIds.has(c.dstBox)) entries.push({ routerId: id, routerOutlet: ch, targetBox: c.dstBox, targetInlet: c.dstInlet });
      }
    }
  }

  return { type: "patch", boxes: patchBoxes, cables: patchCables, audioCables, entries };
}

function deployPatch(): void {
  setDeployedPatch(serializeSynthPatch());
  latestValues.clear();
  // rebuild uplink channel index
  uplinkIndex.clear();
  for (const [id, box] of boxes) {
    if (boxTypeName(box.text) !== "uplink") continue;
    const names = box.text.split(/\s+/).slice(1);
    for (let i = 0; i < names.length; i++) {
      const ch = names[i];
      if (!uplinkIndex.has(ch)) uplinkIndex.set(ch, []);
      uplinkIndex.get(ch)!.push({ boxId: id, outletIndex: i });
    }
  }
  broadcastSynth(getDeployedPatch()!);
  event("patch deployed to " + totalSynthClients() + " clients");
  sendCtrl({ type: "deployed" });
  // re-evaluate consts and devices so rv messages flow immediately after deploy
  evaluateAllConsts();
  evaluateAllDevices();
}

// --- Full state sync for ctrl ---

function getFullState(): Record<string, unknown> {
  const bv: Record<number, BoxValue> = {};
  for (const [id, v] of boxValues) bv[id] = v;
  return {
    type: "state",
    boxes: [...boxes.entries()],
    cables: [...cables.entries()],
    nextId: getPatchNextId(),
    synthBorderY: getSynthBorderY(),
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
    const gridInfo = getGridDeviceInfo();
    if (gridInfo) {
      socket.send(JSON.stringify({ type: "grid-connected", deviceType: gridInfo.deviceType, deviceId: gridInfo.deviceId }));
    }
    const arcInfo = getArcDeviceInfo();
    if (arcInfo) {
      socket.send(JSON.stringify({ type: "arc-connected", deviceType: arcInfo.deviceType, deviceId: arcInfo.deviceId }));
    }
  });

  socket.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "apply") {
        handleApply(msg);
      } else if (msg.type === "midi") {
        if (msg.cc !== undefined) {
          // Named CC sources (breath, bite, nod, tilt)
          const name = CC_SOURCE[msg.cc];
          if (name) {
            const id = findBoxByText(name);
            if (id !== null) setBoxValueAndNotify(id, msg.value / 127);
          }
          const value = msg.value / 127;
          // Generic CC boxes: each box can list one or more CC numbers as args;
          // each arg position maps to a same-indexed outlet. A bare `cc` (no
          // args) is a passive monitor — display the last cc:value, don't
          // propagate.
          for (const [ccId, ccBox] of boxes) {
            if (boxTypeName(ccBox.text) !== "cc") continue;
            const tokens = ccBox.text.split(/\s+/);
            if (tokens.length === 1) {
              boxValues.set(ccId, value);
              queueValueUpdate(ccId, msg.cc + ":" + value.toFixed(2));
              continue;
            }
            for (let i = 1; i < tokens.length; i++) {
              if (parseInt(tokens[i]) === msg.cc) {
                boxValues.set(ccId, value);
                queueValueUpdate(ccId, value);
                propagateAndNotify(ccId, i - 1, value);
              }
            }
          }
        } else if (msg.note !== undefined) {
          // Iterate every `key` box and dispatch based on its args:
          //   `key`       — all channels, fire outlets
          //   `key N`     — channel N only (1–16), fire outlets
          //   `key ?`     — all channels, display-only monitor (no outlets)
          const velocity = (msg.velocity ?? 0) / 127;
          for (const [id, box] of boxes) {
            if (boxTypeName(box.text) !== "key") continue;
            const arg = box.text.split(/\s+/)[1];
            if (arg === "?") {
              const display = `? ${msg.note} ${velocity.toFixed(2)} ch${msg.channel}`;
              boxValues.set(id, display);
              queueValueUpdate(id, display);
              continue;
            }
            if (arg !== undefined) {
              const ch = parseInt(arg);
              if (!isNaN(ch) && ch !== msg.channel) continue;
            }
            boxValues.set(id, msg.note);
            queueValueUpdate(id, msg.note);
            propagateAndNotify(id, 0, msg.note);   // outlet 0: pitch
            propagateAndNotify(id, 1, velocity);    // outlet 1: velocity (0-1)
          }
        }
      } else if (msg.type === "knob") {
        setBoxValueAndNotify(msg.id, msg.value);
      } else if (msg.type === "toggle-click") {
        const state = boxState.get(msg.id);
        if (state) {
          state.value = msg.value;
          setBoxValueAndNotify(msg.id, state.value);
        }
      } else if (msg.type === "ctrl-audio-ready") {
        evaluateAllConsts();
        evaluateAllDevices();
      } else if (msg.type === "event-click") {
        propagateAndNotify(msg.id, 0, 1);
        // Flash the event box briefly
        queueValueUpdate(msg.id, 1);
        setTimeout(() => queueValueUpdate(msg.id, 0), 100);
      } else if (msg.type === "peaks") {
        // fftPeaks~ spectral analysis injected from the ctrl client (audio→control).
        // Propagate amps first (outlet 1) so a downstream `assign` stores them before
        // freqs (outlet 0) trigger its reallocation.
        propagateAndNotify(msg.box, 1, msg.amps);
        propagateAndNotify(msg.box, 0, msg.freqs);
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
    authenticatedIPs.add(clientIP);
    drawStatus();
    socket.send(JSON.stringify({ type: "welcome", id, clients: totalSynthClients() }));
    if (getDeployedPatch()) {
      socket.send(JSON.stringify(getDeployedPatch()));
      for (const data of latestValues.values()) socket.send(data);
    }
    broadcastClientCount();
  });

  socket.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "health") {
        socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
      } else if (msg.type === "up" && typeof msg.ch === "string") {
        const targets = uplinkIndex.get(msg.ch);
        if (targets) {
          for (const { boxId, outletIndex } of targets) {
            boxValues.set(boxId, msg.v);
            queueValueUpdate(boxId, msg.v);
            propagateAndNotify(boxId, outletIndex, msg.v);
          }
        }
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
      if (getDeployedPatch()) {
        send(getDeployedPatch()!);
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

// --- Request handler ---
// One handler for every mode. The captive-portal CNA branch is active only when
// cfg.needsCaptivePortal (performance); in practice/workshop the probe paths
// fall through to ordinary file serving, so the redirect simply doesn't exist.

function appHandler(req: Request, info: Deno.ServeHandlerInfo): Response | Promise<Response> {
  const url = new URL(req.url);
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;

  if (cfg.needsCaptivePortal) {
    const probes = ["/hotspot-detect.html", "/generate_204", "/canonical.html", "/connecttest.txt"];
    if (probes.includes(url.pathname)) {
      if (authenticatedIPs.has(clientIP)) {
        if (url.pathname === "/generate_204") return new Response(null, { status: 204 });
        if (url.pathname === "/connecttest.txt") return new Response("Microsoft Connect Test", { headers: { "content-type": "text/plain" } });
        return new Response("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>", { headers: { "content-type": "text/html" } });
      }
      event(`CNA redirect ${clientIP}`);
      return Response.redirect(`https://${HOST_DOMAIN}:${cfg.appPort}/portal.html`, 302);
    }
  }

  if (url.pathname === "/auth") { authenticatedIPs.add(clientIP); return new Response("ok"); }
  if (url.pathname === "/events") return handleSSE(req, info);
  // route WebSocket by path
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (url.pathname === "/ws/ctrl") return handleCtrlWs(req);
    return handleSynthWs(req, info);
  }
  if (url.pathname.startsWith("/patches")) return handlePatchAPI(req, url);
  if (url.pathname.startsWith("/abstractions")) return handleAbstractionAPI(req, url);
  const ext = url.pathname.split(".").pop()?.toLowerCase();
  if (ext && ["html", "js", "css", "json", "png", "ico", "flac", "wav", "aiff", "aif", "ogg", "mp3", "m4a"].includes(ext)) return serveFile(url.pathname);
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

  // POST /patches/reveal — open the patches folder in Finder (macOS)
  if (req.method === "POST" && url.pathname === "/patches/reveal") {
    try {
      const cmd = new Deno.Command("open", { args: [PATCHES_DIR] });
      await cmd.output();
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, err: String(err) }), { status: 500, headers });
    }
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
    const raw = JSON.parse(await req.text());
    delete raw.synthBorderY;
    await Deno.writeTextFile(`${ABSTRACTIONS_DIR}/${name}.json`, JSON.stringify(raw));
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

// --- Self-signed cert generation (workshop) ---
// Pure-Deno and OS-agnostic: WebCrypto generates the key, @peculiar/x509 builds
// the cert — no openssl, no system tool. RSA-2048 (not EC): Deno's rustls accepts
// RSA reliably, whereas macOS LibreSSL's EC output was rejected with KeyMismatch.
// Deps are lazy-imported so only workshop mode loads the tree. Writes SELF_* only.
async function genSelfSignedCert(): Promise<void> {
  const ip = getLanIP();
  try {
    await import("reflect-metadata"); // tsyringe polyfill — must load before x509
    const x509 = await import("@peculiar/x509");

    const alg: RsaHashedKeyGenParams = {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      publicExponent: new Uint8Array([1, 0, 1]),
      modulusLength: 2048,
    };
    const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]) as CryptoKeyPair;

    const names = [
      { type: "dns", value: "localhost" },
      { type: "ip", value: "127.0.0.1" },
      ...(ip ? [{ type: "ip", value: ip }] : []),
    ];
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=local.assembly.fm",
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      signingAlgorithm: alg,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.SubjectAlternativeNameExtension(
          names as ConstructorParameters<typeof x509.SubjectAlternativeNameExtension>[0],
        ),
      ],
    }, crypto);

    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    await Deno.writeTextFile(SELF_CERT_FILE, cert.toString("pem"));
    await Deno.writeTextFile(SELF_KEY_FILE, x509.PemConverter.encode([pkcs8], "PRIVATE KEY"));

    const san = names.map((n) => `${n.type}:${n.value}`).join(",");
    console.log(`\x1b[32m✓ generated self-signed cert\x1b[0m (SAN: ${san})`);
  } catch (e) {
    console.error("\x1b[31m✗ workshop mode could not generate a self-signed cert.\x1b[0m");
    console.error("  The cert dependencies may not be installed — run `deno task setup` once with internet.");
    console.error(`  ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
}

const lanIP = getLanIP();

// --- Start ---

const isMacOS = Deno.build.os === "darwin";

// Resolve TLS material per mode. performance requires a real cert (fail loud);
// workshop generates a self-signed one once; practice serves plain HTTP.
let cert: string | undefined;
let key: string | undefined;
if (cfg.certKind === "letsencrypt") {
  if (!(await hasCerts())) {
    console.error("\x1b[31m✗ performance mode requires a real TLS cert.\x1b[0m");
    console.error(`  Missing ${CERT_FILE} and/or ${KEY_FILE} — a Let's Encrypt cert for ${HOST_DOMAIN}.`);
    console.error("  Use workshop mode for an auto-generated self-signed cert, or see notes/network-and-modes.md.");
    Deno.exit(1);
  }
  cert = await Deno.readTextFile(CERT_FILE);
  key = await Deno.readTextFile(KEY_FILE);
} else if (cfg.certKind === "self-signed") {
  const exists = (p: string) => Deno.stat(p).then(() => true).catch(() => false);
  if (!((await exists(SELF_CERT_FILE)) && (await exists(SELF_KEY_FILE)))) await genSelfSignedCert();
  cert = await Deno.readTextFile(SELF_CERT_FILE);
  key = await Deno.readTextFile(SELF_KEY_FILE);
}

// dnsmasq DNS-hijack check — performance only.
if (cfg.needsDnsmasqWarning) {
  try {
    const dnsCheck = await Deno.resolveDns("test.example.com", "A", { nameServer: { ipAddr: "127.0.0.1", port: 53 } });
    const allPointToHost = dnsCheck.every(record => record === HOST_IP);
    if (!allPointToHost) {
      console.log("\x1b[33m⚠️  WARNING: dnsmasq may not be configured correctly!\x1b[0m");
      console.log(`\x1b[33mCaptive portal requires all DNS queries to resolve to ${HOST_IP}\x1b[0m`);
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

// serialosc / monome — orthogonal to mode, macOS-only.
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

// --- Banner ---
if (MODE === "workshop" && !lanIP) {
  console.log("\x1b[33m⚠️  workshop mode: no LAN IPv4 detected — connect to a network so phones can reach the server.\x1b[0m");
}
const scheme = cfg.certKind === "none" ? "http" : "https";
const appHost = MODE === "performance" ? HOST_DOMAIN : MODE === "workshop" ? (lanIP ?? "0.0.0.0") : "localhost";
const portSuffix = cfg.appPort === 443 ? "" : `:${cfg.appPort}`;
const base = `${scheme}://${appHost}${portSuffix}`;
const lanNote = MODE === "performance" && lanIP && lanIP !== HOST_IP ? `\n  \x1b[90mLAN IP:   ${lanIP}\x1b[0m` : "";
const banner = `
  \x1b[1mlocal.assembly.fm\x1b[0m  \x1b[90m[${MODE}]\x1b[0m
  synth:    ${base}/
  ctrl:     ${base}/ctrl.html
  ensemble: ${base}/ensemble.html${lanNote}
`;
console.log(banner);

// Onboarding QR — workshop/performance only (a localhost QR is useless in
// practice). qrText lazy-loads the encoder, so practice never pulls the dep.
if (MODE !== "practice") {
  console.log(`  \x1b[90mwifi:\x1b[0m     ${WIFI_SSID} / ${WIFI_PASSWORD}`);
  console.log(await qrText(`${base}/`, "ascii"));
  console.log("  \x1b[90mscan to play · run `deno task qr` for a printable WiFi + URL poster\x1b[0m\n");
}

// --- Serve ---
// practice: app only, plain HTTP, localhost. workshop: app only, HTTPS, LAN.
// performance: captive-portal HTTP listener + HTTPS app listener.
try {
  if (cfg.portalPort !== null) {
    Deno.serve({ port: cfg.portalPort, hostname: cfg.bindHost }, (req, info) => appHandler(req, info));
  }
  if (cfg.certKind === "none") {
    Deno.serve({ port: cfg.appPort, hostname: cfg.bindHost }, (req, info) => appHandler(req, info));
  } else {
    Deno.serve({ port: cfg.appPort, hostname: cfg.bindHost, cert: cert!, key: key! }, (req, info) => appHandler(req, info));
  }
} catch (e) {
  if (e instanceof Deno.errors.PermissionDenied) {
    const ports = cfg.portalPort !== null ? `${cfg.portalPort}/${cfg.appPort}` : `${cfg.appPort}`;
    console.error(`\x1b[31m✗ permission denied binding port ${ports}.\x1b[0m`);
    console.error("  performance mode binds privileged ports 80/443 — run it with sudo (./start-macos.sh).");
    Deno.exit(1);
  }
  throw e;
}

drawStatus();

setInterval(() => {
  broadcastSynth({ type: "health", ts: Date.now() });
  for (const socket of ctrlSockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
  }
}, 5000);
