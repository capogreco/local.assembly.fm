// deploy.ts — what the server sends a client to build: the phone deploy (the
// many side) and the laptop deploy (one-side audio, built by the ctrl page).
// Both have the same shape. Reads the applied patch (patch-state.ts) after
// sides are stamped.

import { type Box, boxes, cables, cablesFromOutlet } from "./patch-state.ts";
import { sideStamped } from "./eval-engine.ts";
import { boxTypeName, deployInletDefs, getBoxDef, isAudioBox, isDac } from "./public/gpi-types.js";

// One deployed box, or null (logged) for a type with no definition.
// deno-lint-ignore no-explicit-any
function deployBox(id: number, box: Box): any {
  const def = getBoxDef(box.text);
  if (!def) {
    console.log(`\x1b[31m✗ deploy skipped box ${id} "${box.text}": no definition\x1b[0m`);
    return null;
  }
  const name = boxTypeName(box.text), args = box.text.split(/\s+/).slice(1).join(" ");
  // deno-lint-ignore no-explicit-any
  const pb: any = { id, type: name, args, inletDefs: deployInletDefs(box.text) };
  if (isDac(box.text)) pb.dac = true;
  // Any audio box with number inlets needs paramNames for the client
  if (isAudioBox(box.text)) {
    pb.engine = true;
    pb.paramNames = def.inlets.map((i: { name: string; type: string }) => i.type === "audio" ? null : i.name);
    // Message ports go to the worklet's MessagePort instead of an AudioParam
    pb.messagePorts = def.inlets
      .filter((i: { type: string; message?: boolean }) => i.type === "event" || i.message)
      .map((i: { name: string }) => i.name);
  }
  return pb;
}

// Boxes on one partition, and the cables among them split into audio cables
// (source outlet type audio) and control cables.
function deployPartition(inPartition: (box: Box) => boolean) {
  // deno-lint-ignore no-explicit-any
  const patchBoxes: any[] = [], patchCables: any[] = [], audioCables: any[] = [];
  const ids = new Set<number>();
  for (const [id, box] of boxes) {
    if (!inPartition(box)) continue;
    const pb = deployBox(id, box);
    if (!pb) continue;
    ids.add(id);
    patchBoxes.push(pb);
  }
  for (const [, c] of cables) {
    if (!ids.has(c.srcBox) || !ids.has(c.dstBox)) continue;
    const srcBox = boxes.get(c.srcBox);
    const srcDef = srcBox ? getBoxDef(srcBox.text) : null;
    const srcOutlet = srcDef?.outlets?.[c.srcOutlet];
    const cable = { srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet };
    if (srcOutlet?.type === "audio") audioCables.push(cable);
    else patchCables.push(cable);
  }
  return { ids, patchBoxes, patchCables, audioCables };
}

export function serializeSynthPatch(): Record<string, unknown> {
  // deno-lint-ignore no-explicit-any
  const entries: any[] = [];
  const { ids: synthIds, patchBoxes, patchCables, audioCables } = deployPartition((box) => sideStamped(box) === "many");

  for (const [id, box] of boxes) {
    if (sideStamped(box) !== "border") continue;
    if (boxTypeName(box.text) === "sall") {
      // sall: match many-side r/receive boxes by name (multi-name: each name maps to a channel)
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

// The laptop deploy: one-side audio boxes and the audio cables among them.
// The server evaluates one-side control, so there are no control cables; it
// reaches each box as rv/re addressed to the box itself (r = box id, ch =
// inlet), which the entries spell out: one per non-audio inlet. Sent even when
// empty, so the ctrl page tears down the previous laptop audio.
export function serializeLaptopPatch(): Record<string, unknown> {
  const { patchBoxes, audioCables } = deployPartition((box) => sideStamped(box) === "one" && isAudioBox(box.text));
  // deno-lint-ignore no-explicit-any
  const entries: any[] = [];
  for (const b of patchBoxes) {
    b.paramNames.forEach((p: string | null, i: number) => {
      if (p !== null) entries.push({ routerId: b.id, routerOutlet: i, targetBox: b.id, targetInlet: i });
    });
  }
  return { type: "patch", boxes: patchBoxes, cables: [], audioCables, entries };
}
