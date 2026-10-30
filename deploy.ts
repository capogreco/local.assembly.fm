// deploy.ts — what the server sends a client to build: the phone deploy.
// Reads the applied patch (patch-state.ts) after sides are stamped.

import { boxes, cables, cablesFromOutlet } from "./patch-state.ts";
import { sideStamped } from "./eval-engine.ts";
import { boxTypeName, deployInletDefs, getBoxDef, isAudioBox, isDac } from "./public/gpi-types.js";

export function serializeSynthPatch(): Record<string, unknown> {
  // deno-lint-ignore no-explicit-any
  const patchBoxes: any[] = [], patchCables: any[] = [], entries: any[] = [];
  const synthIds = new Set<number>();

  for (const [id, box] of boxes) {
    const def = getBoxDef(box.text);
    if (!def) {
      console.log(`\x1b[31m✗ deploy skipped box ${id} "${box.text}": no definition\x1b[0m`);
      continue;
    }
    if (sideStamped(box) === "many") {
      synthIds.add(id);
      const name = boxTypeName(box.text), args = box.text.split(/\s+/).slice(1).join(" ");
      // deno-lint-ignore no-explicit-any
      const pb: any = { id, type: name, args, inletDefs: deployInletDefs(box.text) };
      if (isDac(box.text)) pb.dac = true;
      // Any audio box with number inlets needs paramNames for the synth client
      if (isAudioBox(box.text)) {
        pb.engine = true;
        pb.paramNames = def.inlets.map((i: { name: string; type: string }) => i.type === "audio" ? null : i.name);
        // Message ports go to the worklet's MessagePort instead of an AudioParam
        pb.messagePorts = def.inlets
          .filter((i: { type: string; message?: boolean }) => i.type === "event" || i.message)
          .map((i: { name: string }) => i.name);
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
