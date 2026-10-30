/**
 * Snapshot of what the server deploys, per saved patch: the phone deploy
 * (serializeSynthPatch) byte for byte, as phones receive it.
 *
 * Usage:
 *   deno run --allow-read --allow-write tests/deploy_snapshot.ts capture
 *   deno run --allow-read tests/deploy_snapshot.ts verify
 */

import { applyPatch, type AbstractionDef } from "../apply-check.ts";
import { serializeSynthPatch } from "../deploy.ts";

// Tomorrow's four, plus the one-side audio and sall cases.
const PATCHES = ["ks_arp", "frogs", "panharmonium", "epimetheus", "fftPeak_test", "cute-sine_keys", "archive/sall_test", "archive/symbiogenesis"];

const loaded = new Map<string, AbstractionDef>();
for (const e of Deno.readDirSync("abstractions")) {
  const raw = JSON.parse(Deno.readTextFileSync(`abstractions/${e.name}`));
  loaded.set(e.name.replace(/\.json$/, ""), { boxes: new Map(raw.boxes), cables: new Map(raw.cables) });
}

function runAll(): Record<string, string> {
  const results: Record<string, string> = {};
  for (const name of PATCHES) {
    const r = applyPatch(JSON.parse(Deno.readTextFileSync(`patches/${name}.json`)), loaded);
    if (r.errors.length > 0) throw new Error(`${name}: ${r.errors.join("; ")}`);
    results[`${name} phone`] = JSON.stringify(serializeSynthPatch());
  }
  return results;
}

const mode = Deno.args[0] || "verify";
const baselinePath = "tests/deploy_baseline.json";

if (mode === "capture") {
  const results = runAll();
  await Deno.writeTextFile(baselinePath, JSON.stringify(results, null, 2) + "\n");
  console.log(`Captured ${Object.keys(results).length} deploys → ${baselinePath}`);
} else if (mode === "verify") {
  const baseline = JSON.parse(await Deno.readTextFile(baselinePath));
  const current = runAll();
  let pass = 0, fail = 0;
  for (const name of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    if (baseline[name] === current[name]) { pass++; continue; }
    fail++;
    console.log(`FAIL: ${name}`);
    console.log(`  baseline: ${baseline[name]?.slice(0, 400)}`);
    console.log(`  current:  ${current[name]?.slice(0, 400)}`);
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) Deno.exit(1);
} else {
  console.error(`Unknown mode: ${mode}. Use 'capture' or 'verify'.`);
  Deno.exit(1);
}
