/**
 * Snapshot of what the server deploys, per saved patch: the phone deploy
 * (serializeSynthPatch) byte for byte, as phones receive it, and the laptop
 * deploy (serializeLaptopPatch) the ctrl page builds ctrl-side audio from.
 *
 * Usage:
 *   deno run --allow-read --allow-write tests/deploy_snapshot.ts capture
 *   deno run --allow-read tests/deploy_snapshot.ts verify
 */

import { applyPatch, parseAbstraction, type AbstractionDef } from "../apply-check.ts";
import { serializeLaptopPatch, serializeSynthPatch } from "../deploy.ts";

// Tomorrow's four, plus the ctrl-side audio, sall and buffer~ cases.
const PATCHES = ["ks_arp", "frogs", "panharmonium", "epimetheus", "fftPeak_test", "cute-sine_keys", "archive/sall_test", "archive/symbiogenesis", "granular_example"];

const loaded = new Map<string, AbstractionDef>();
for (const lib of Deno.readDirSync("libs")) {
  for (const e of Deno.readDirSync(`libs/${lib.name}/abstractions`)) {
    const name = `${lib.name}/${e.name.replace(/\.json$/, "")}`;
    const { def, errors } = parseAbstraction(name, JSON.parse(Deno.readTextFileSync(`libs/${name.replace("/", "/abstractions/")}.json`)));
    if (!def) throw new Error(`${name}: ${errors.join("; ")}`);
    loaded.set(name, def);
  }
}

function runAll(): Record<string, string> {
  const results: Record<string, string> = {};
  for (const name of PATCHES) {
    const r = applyPatch(JSON.parse(Deno.readTextFileSync(`${name.startsWith("granular_") ? "patches" : "tests/fixtures"}/${name}.json`)), loaded);
    if (r.errors.length > 0) throw new Error(`${name}: ${r.errors.join("; ")}`);
    results[`${name} phone`] = JSON.stringify(serializeSynthPatch());
    results[`${name} laptop`] = JSON.stringify(serializeLaptopPatch());
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
