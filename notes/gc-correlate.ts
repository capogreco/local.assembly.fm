#!/usr/bin/env -S deno run -R
// gc-correlate.ts — turn a profiling log into a GC-vs-galloping verdict.
//
// Reads a combined log produced by:
//   PROFILE_TICK=1 PROFILE_ONSET=1 deno run -A --unstable-net \
//     --v8-flags=--trace-gc server.ts 2>&1 | tee /tmp/ewing-gc.log
//
// Then:  deno run -R notes/gc-correlate.ts /tmp/ewing-gc.log
//
// It answers one question for the Rust/native decision: is the server's timing
// jitter ("galloping") caused by V8 garbage collection (an ACCIDENTAL affordance,
// fixable with Tier 0+1 — scheduler-off-tick + allocation hygiene), or is it
// something a runtime port can't touch (wifi = CONSTITUTIVE; or a hot path)?
//
// See notes/server-timing-runtime-analysis.md for the framing.

// ---------- parsing ----------

interface LateTick { t: number; interval: number; over: number }
interface Gc { t: number; type: string; pause: number; major: boolean }
interface Onset { t: number; k: string; dst: string }
interface TickAgg { p50: number; p95: number; p99: number; max: number; target: number }

const RE_TICK = /^\[tick-profile\] p50=([\d.]+)ms p95=([\d.]+)ms p99=([\d.]+)ms max=([\d.]+)ms \(target=([\d.]+)ms\)/;
const RE_LATE = /^\[tick-late\] t=([\d.]+) interval=([\d.]+) over=([\d.]+)/;
const RE_ONSET = /^\[onset\] t=([\d.]+) k=(\S+) dst=(\S+)/;
// V8 --trace-gc:  [pid:0xaddr]   1083 ms: Mark-Compact 14.2 (18.0) -> 9.8 (17.5) MB, 22.5 / 0.0 ms  (...)
const RE_GC = /^\[\d+:0x[0-9a-f]+\]\s+([\d.]+)\s+ms:\s+(\S+)\s+.*?,\s+([\d.]+)\s*\/\s*[\d.]+\s+ms/;

const path = Deno.args[0] ?? "/tmp/ewing-gc.log";
let text: string;
try {
  text = await Deno.readTextFile(path);
} catch (e) {
  console.error(`Could not read ${path}: ${(e as Error).message}`);
  console.error(`Usage: deno run -R notes/gc-correlate.ts <logfile>`);
  Deno.exit(1);
}

const lates: LateTick[] = [];
const gcs: Gc[] = [];
const onsets: Onset[] = [];
const aggs: TickAgg[] = [];

for (const line of text.split("\n")) {
  let m: RegExpMatchArray | null;
  if ((m = line.match(RE_LATE))) {
    lates.push({ t: +m[1], interval: +m[2], over: +m[3] });
  } else if ((m = line.match(RE_ONSET))) {
    onsets.push({ t: +m[1], k: m[2], dst: m[3] });
  } else if ((m = line.match(RE_TICK))) {
    aggs.push({ p50: +m[1], p95: +m[2], p99: +m[3], max: +m[4], target: +m[5] });
  } else if ((m = line.match(RE_GC))) {
    const type = m[2];
    const pause = +m[3];
    gcs.push({ t: +m[1], type, pause, major: /^Mark/i.test(type) });
  }
}

// ---------- helpers ----------

const fmt = (n: number, d = 2) => n.toFixed(d);
function stats(xs: number[]) {
  if (xs.length === 0) return { n: 0, mean: 0, std: 0, median: 0, min: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { n: xs.length, mean, std, median: s[s.length >> 1], min: s[0], max: s[s.length - 1] };
}
function hr() { console.log("─".repeat(64)); }

console.log(`\nParsed ${path}`);
console.log(`  ${aggs.length} per-second tick aggregates, ${lates.length} late ticks, ${gcs.length} GC events, ${onsets.length} onsets`);

// ---------- 1. tick summary ----------

hr();
console.log("TICK TIMING");
if (aggs.length) {
  const target = aggs[0].target;
  const worstMax = Math.max(...aggs.map((a) => a.max));
  const p99s = stats(aggs.map((a) => a.p99));
  const badSeconds = aggs.filter((a) => a.max > target * 2).length;
  console.log(`  target interval     ${fmt(target)} ms`);
  console.log(`  worst single tick   ${fmt(worstMax)} ms  (${fmt(worstMax / target, 1)}× target)`);
  console.log(`  median per-sec p99  ${fmt(p99s.median)} ms`);
  console.log(`  seconds with a >2×-target spike: ${badSeconds}/${aggs.length}`);
} else {
  console.log("  (no [tick-profile] lines — was PROFILE_TICK=1 set?)");
}

// ---------- 2. GC summary ----------

hr();
console.log("GARBAGE COLLECTION");
if (gcs.length) {
  const major = gcs.filter((g) => g.major);
  const minor = gcs.filter((g) => !g.major);
  const majorPause = stats(major.map((g) => g.pause));
  const totalPause = gcs.reduce((a, g) => a + g.pause, 0);
  console.log(`  ${minor.length} minor (Scavenge), ${major.length} major (Mark-Compact)`);
  console.log(`  total GC pause time ${fmt(totalPause)} ms`);
  if (major.length) {
    console.log(`  major-GC pause      mean ${fmt(majorPause.mean)} ms, max ${fmt(majorPause.max)} ms`);
  }
} else {
  console.log("  (no GC lines — was --v8-flags=--trace-gc set, and 2>&1 piped to the log?)");
}

// ---------- 3. correlation: are late ticks caused by GC? ----------

hr();
console.log("CORRELATION  (late ticks vs GC pauses)");

const MIN_PAUSE = 3;        // ms — ignore trivial GCs
const WINDOW = 25;          // ms — coincidence tolerance
const sigGcs = gcs.filter((g) => g.pause >= MIN_PAUSE).sort((a, b) => a.t - b.t);

let verdict = "INSUFFICIENT DATA";
let detail = "";

if (lates.length === 0) {
  detail = aggs.length
    ? "No late ticks above 2× target — the scheduler is clean. Galloping (if heard) is NOT server timing; look to wifi (constitutive) or the audio path."
    : "No tick instrumentation in this log.";
} else if (sigGcs.length === 0) {
  detail = "Late ticks exist but no significant GC pauses to blame. The jitter is NOT garbage collection — likely a propagation hot path. A runtime port would not fix this.";
  verdict = "NOT GC";
} else {
  // auto-align the two clocks: pick the offset maximising coincidences
  const matchAt = (off: number) => {
    let hit = 0;
    for (const L of lates) {
      const tt = L.t + off;
      // nearest significant GC
      for (const g of sigGcs) {
        if (Math.abs(g.t - tt) <= WINDOW) { hit++; break; }
      }
    }
    return hit;
  };
  const offsets: number[] = [];
  for (let off = -200; off <= 200; off += 2) offsets.push(off);
  const sweep = offsets.map(matchAt);
  const bestHit = Math.max(...sweep);
  // many offsets may tie (window is wider than the skew); report the band centre
  const band = offsets.filter((_, i) => sweep[i] === bestHit);
  const bestOff = band[band.length >> 1];
  // chance baseline: median matches across the swept offsets
  const chance = stats(sweep).median;

  // at the best offset, gather magnitude agreement (over ≈ pause?)
  const ratios: number[] = [];
  let explainedOver = 0, totalOver = 0;
  for (const L of lates) {
    totalOver += L.over;
    const tt = L.t + bestOff;
    let near: Gc | null = null;
    for (const g of sigGcs) {
      if (Math.abs(g.t - tt) <= WINDOW && (!near || Math.abs(g.t - tt) < Math.abs(near.t - tt))) near = g;
    }
    if (near) { ratios.push(L.over / near.pause); explainedOver += L.over; }
  }
  const pct = (bestHit / lates.length) * 100;
  const rstat = stats(ratios);
  console.log(`  clock offset (auto) ${bestOff >= 0 ? "+" : ""}${bestOff} ms`);
  console.log(`  late ticks coincident with a GC: ${bestHit}/${lates.length} (${fmt(pct, 0)}%)  [chance ≈ ${fmt((chance / lates.length) * 100, 0)}%]`);
  console.log(`  over-budget time explained by GC: ${fmt((explainedOver / Math.max(totalOver, 1e-9)) * 100, 0)}%`);
  if (ratios.length) console.log(`  lateness / GC-pause ratio: median ${fmt(rstat.median, 2)} (≈1.0 means GC fully accounts for the stall)`);

  const strong = pct >= 60 && (chance / lates.length) < 0.4 && rstat.median > 0.5 && rstat.median < 2.0;
  if (strong) {
    verdict = "GC CONFIRMED";
    detail = "The galloping is V8 garbage collection — an ACCIDENTAL affordance. Lever: Tier 0 (scheduler off the tick) + Tier 1 (allocation hygiene). Native sidecar (Tier 3a) only if it survives that. A full Rust/C++ port is unjustified by this evidence.";
  } else if (pct >= 30) {
    verdict = "GC PARTIAL";
    detail = "GC explains some but not all of the jitter. Do Tier 0+1 (cheap, removes the GC share), then re-measure before considering anything native.";
  } else {
    verdict = "NOT GC";
    detail = "Late ticks are not GC-aligned. The cause is elsewhere (hot path, event-loop pressure, or — if only audible in the distributed setup — wifi, which is constitutive). A runtime port would not address it.";
  }
}

// ---------- 4. onset rhythm (clumping vs spreading) ----------

hr();
console.log("ONSET RHYTHM  (inter-onset intervals per stream)");
if (onsets.length) {
  // group by stream key, dedupe near-simultaneous fan-out across clients
  const byKey = new Map<string, number[]>();
  for (const o of onsets) {
    const arr = byKey.get(o.k) ?? [];
    arr.push(o.t);
    byKey.set(o.k, arr);
  }
  const rows = [...byKey.entries()].map(([k, ts]) => {
    ts.sort((a, b) => a - b);
    const dedup: number[] = [];
    for (const t of ts) if (dedup.length === 0 || t - dedup[dedup.length - 1] > 1) dedup.push(t);
    const iois: number[] = [];
    for (let i = 1; i < dedup.length; i++) iois.push(dedup[i] - dedup[i - 1]);
    const s = stats(iois);
    const med = s.median || 1;
    const clump = iois.filter((x) => x < 0.5 * med || x > 1.5 * med).length / Math.max(iois.length, 1);
    return { k, onsets: dedup.length, meanIOI: s.mean, cv: s.std / (s.mean || 1), clump };
  }).sort((a, b) => b.onsets - a.onsets);

  console.log("  stream(type:router:ch)      onsets   meanIOI   CV     clumped");
  for (const r of rows.slice(0, 6)) {
    console.log(`  ${r.k.padEnd(26)} ${String(r.onsets).padStart(6)}   ${fmt(r.meanIOI).padStart(6)}ms  ${fmt(r.cv, 2).padStart(4)}   ${fmt(r.clump * 100, 0).padStart(3)}%`);
  }
  console.log("  (CV<0.15 ≈ tight/even; high CV or high clumped% ≈ galloping. Compare");
  console.log("   localhost numbers here against a later networked run to separate the");
  console.log("   runtime's contribution from wifi's.)");
} else {
  console.log("  (no [onset] lines — was PROFILE_ONSET=1 set?)");
}

// ---------- verdict ----------

hr();
console.log(`VERDICT: ${verdict}`);
console.log(detail.replace(/(.{1,62})(\s|$)/g, "  $1\n").trimEnd());
hr();
console.log();
