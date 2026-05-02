# Server timing & runtime-port analysis

*Started 2026-05-02. Working document. Not a decision, an analysis.*

## Why this doc exists

The question came up: should we, long-term, port the server off Deno onto
something with tighter timing guarantees (Bun, Rust, Go, C++)? This doc
captures what we know, what we suspect, and what we'd need to confirm
before committing to anything irreversible.

## The observation that triggered the inquiry

**Practising the `ks_arp` patch with the ensemble client on the Mac Studio,
controlled from the MBP**, produced "galloping, chaotic rhythms." The
ensemble client is interesting because it largely controls for WiFi: all
synth voices are in one process sharing one WS connection, all receiving
broadcast messages at the same instant. So perceived rhythmic chaos in
that setup is *not* per-phone WiFi variance. It's something else.

The user grew to embrace those rhythms as artifacts of WiFi chaos in the
distributed setup, but the ensemble experience suggested an additional
source.

## Diagnostic interpretation: clumping vs. spreading

The descriptor "galloping" is acoustically meaningful. There are two
sonic signatures of timing variance:

- **Spreading** — events smear evenly around their target, the pulse
  feels loose but doesn't cluster. Random independent jitter (e.g.
  per-phone WiFi latency) sounds like this.
- **Clumping** — events fire in tight groups, then a gap, then another
  tight group. Galloping. Unpredictable in a different way.

Clumping is consistent with **garbage-collection-induced scheduling**.
Mechanism: V8 fires a major GC, the entire JS thread stalls for 10–50 ms.
During the stall, no `setInterval` callbacks fire, no WS sends happen.
When GC finishes, the event loop catches up — but the stalled work
arrives all at once. Events that should have been spread evenly across
the GC interval now arrive bunched together. Then a "quiet" period until
the next GC. Galloping.

This intuition is consistent with what the user has heard. The next
section says how to confirm it.

## Confirmation plan (before any port)

Two metrics. Run both during a 2-minute `ks_arp` ensemble session.

**Status (2026-05-02): instrumentation is in place, profiling session
not yet run.** `eval-engine.ts:833` wraps `tick()` with an
`EWING_PROFILE_TICK`-gated profiler. Dormant by default; activate by
setting the env var before running. Output format:
`[tick-profile] p50=Xms p95=Xms p99=Xms max=Xms (target=Xms)` once per
second. Pair with `--v8-flags=--trace-gc` to cross-correlate. The
actual measurement requires homebase hardware (phones, ensemble client,
MPK Mini, monome) so it's interactive and local — can't be done by a
remote scheduled agent. Run command and full plan are in `dev_log.md`
under "Tick-profile instrumentation landed" 2026-05-02.

**Tick interval logging** (already implemented in eval-engine.ts):
```ts
let lastTickAt = 0;
const intervals: number[] = [];
setInterval(() => {
  const now = performance.now();
  if (lastTickAt > 0) intervals.push(now - lastTickAt);
  lastTickAt = now;
  if (intervals.length === TICK_RATE) {
    intervals.sort((a, b) => a - b);
    const p50 = intervals[TICK_RATE >> 1];
    const p95 = intervals[Math.floor(TICK_RATE * 0.95)];
    const max = intervals[TICK_RATE - 1];
    console.log(`tick p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`);
    intervals.length = 0;
  }
  tick();
}, 1000 / TICK_RATE);
```

**GC tracing**: run with `--v8-flags=--trace-gc`. Each GC will print a
line with timestamp and pause duration to stderr. Cross-correlate gallop
events with GC events. If they line up, the runtime IS the cause.

Expected reading if GC is the culprit: max tick interval episodically
spiking to 15–50 ms with periodicity of seconds, each spike coinciding
with a GC log line.

## What's actually contributing to "looseness"

Ranked by likely magnitude on a typical session:

1. **WiFi (5–20 ms typical, ±10–30 ms spikes).** Independent of runtime.
   Dominant for *between-phone* tightness in the distributed setup.
   Eliminated in the ensemble experiment.
2. **V8 GC pauses (5–50 ms occasional).** This is the residual after WiFi
   is removed. The ensemble galloping is most likely this.
3. **Tick quantization (4.17 ms at TICK_RATE=240).** Eliminated by the
   scheduler refactor in `memory/project_tick_paradigm.md`. Not a
   runtime issue — fixed by changing the architecture, not the language.
4. **Event loop latency under heavy WS/OSC load.** Sub-ms typical, can
   reach a few ms. Marginal.
5. **Phone-side AudioWorklet block boundaries (~3 ms).** Independent of
   server runtime. Bounded.

## The fix tree

In strict order of "do this first":

### Tier 0 — Scheduler refactor (already planned)

Move `metro`, `delay`, `step` off the 60–240 Hz tick loop onto a
`performance.now()`-keyed min-heap. Sub-ms accuracy on event firing,
modulo GC. Doesn't fix GC; does eliminate the quantization floor.

Captured in `memory/project_tick_paradigm.md`. Phase 1 of the broader
audio-rate evolution there. ~3–4 days work plus virtual-clock test
harness. Should happen before any runtime decision because it changes
which code paths are hot.

### Tier 1 — GC hygiene inside Deno

Cheap, high-leverage. ~1–2 days of profiling.

- **Object pooling for hot-path allocations.** Each tick currently
  allocates a number of small objects: per-event `{type, r, ch, v}`
  message dictionaries, `updates` accumulators in `propagateAndNotify`,
  `outputs` arrays for stateful boxes. Reuse these from a pool.
- **Pre-allocated arrays where possible.** `inletValues` arrays grow
  dynamically; pre-size to known inlet counts at box-state init.
- **Run with `--v8-flags=--max-old-space-size=4096`** (or higher).
  Reduces major-GC frequency by giving V8 more headroom.
- **Eliminate `console.log` from hot paths during performance.**
  Synchronous stdio writes block the event loop. Wrap in a
  `if (graphDebug)` flag and ensure flag is off during shows.
- **Avoid string concatenation in hot paths.** `routerBoxId + ":" + ch`
  is allocating new strings per call. Use Map<number, Map<number, X>>
  or pre-computed numeric keys.

If GC is the dominant cause of galloping, this likely cuts audible
artifact by 60–80% with minimal risk. Should be done regardless of any
port decision.

### Tier 2 — Bun trial (low-cost experiment)

Bun uses JavaScriptCore (Safari's engine), which has a different GC
profile than V8 — generally shorter major-GC pauses, sometimes more
frequent minor GCs.

- Cost: a few days of API compatibility work. `Deno.serve`,
  `Deno.listenDatagram`, file APIs, TLS. Most logic stays as-is.
- Realistic gain: 10–30% lower jitter on hot paths, smaller GC tail
  latency. Could be more if our pattern hits V8 worst-case GC behaviour.
- Risk: low. Maintain a Bun branch alongside Deno. If it's not better,
  abandon.
- Important: do this *after* Tier 1, otherwise we'd be benchmarking
  un-optimised allocations on a different runtime and learning nothing
  meaningful.

### Tier 3a — Native sidecar scheduler (hybrid)

The bulk of the server stays in Deno/TypeScript. Only the
timing-critical event scheduler moves into a small native process
(Rust or Go) that the Deno server talks to via Unix socket or shared
memory.

The TS side computes "fire WS send to client X with payload Y at
wall-clock time T." The native side holds a heap of pending events,
fires each at exactly T with no GC. The TS side can pause for GC and
nothing audible happens — outbound dispatch keeps running.

- Cost: the small native part is ~weeks. Inter-process protocol design
  is the actual hard part.
- Gain: eliminates GC variance from the *outbound* timing path. Inbound
  (ctrl events, OSC) is still TS-side and still subject to GC, but at
  the chord/metro scale that's much less audible.
- Preserves live-edit ergonomics for everything else (patch storage,
  graph evaluation, captive portal, ctrl-side eval).
- Doesn't require porting `graph-core.js` — the unification (2026-04-23)
  stays intact.

This is the "principled mid-cost" option if Tier 1 + Tier 2 aren't
enough.

### Tier 3b — Full port to Rust or Go

Eliminates GC variance entirely (Rust) or substantially (Go's GC is
sub-ms typical). Single-digit microsecond jitter. Sub-ms event firing
accuracy. Hardware-grade timing.

- Cost: months. Graph evaluation logic in Rust is significantly more
  verbose; the dynamic typing of values (number/array/null) becomes an
  enum, every dispatch becomes a match.
- WS/HTTPS/OSC well-served by `tokio + axum + tokio-websockets + rosc`.
  Mature, fast.
- **Hidden cost:** loses the shared `graph-core.js` between server and
  client. Either re-implement the graph dispatch in Rust→WASM for the
  client (huge), or maintain two parallel implementations (the bug class
  the unification was supposed to close).
- **Live-coding ergonomic loss is real.** TS lets you reload a worklet
  and see the change immediately. In Rust you're recompiling. For a
  system iteratively built during composition, this is a real cost.
- Worth it if Tier 1/2/3a aren't enough AND the project moves toward
  more rhythmically demanding material AND the user accepts the
  ergonomic tradeoff.

### Tier 4 — C++

Maximum performance, worst dev experience. Memory-safety burden, hard
build/dependency story. Only worth considering if the project eventually
moves toward server-side synthesis (currently the phones do all the
audio). Not warranted by current goals.

## The live-coding tradeoff (why we'd resist a full port)

Worth being explicit about. The system is designed for live-edit:
patches are edited in `ctrl.html`, `--watch` reloads server-side
TypeScript, worklets reload on the synth clients. A change in the engine
or a graph evaluator can be heard within seconds.

A full port to Rust or Go disrupts this in non-obvious ways:
- The engine stays TypeScript (worklets in browser), so worklet changes
  still hot-reload. That part's fine.
- The graph evaluation, server logic, hardware bridge — all become
  compiled Rust. Edit-rebuild-redeploy cycles are tens of seconds at
  best, often minutes.
- Patch composition speed slows. Fewer experiments per session.
- Dynamic features (hot-loaded abstractions, server-side patch
  manipulation) become harder.

Even if a full port would theoretically give us perfect timing, would it
slow down composition enough that fewer pieces get made? For a system
whose value is partially in iteration speed, this is the real cost.

The hybrid (Tier 3a) sidesteps this: we keep TS for everything except
the small timing-critical scheduler. Most of the live-edit speed
preserved, most of the timing benefit gained.

## Recommendation

In order, with stop-checks:

1. **Tier 0 + Tier 1 first.** Scheduler refactor + GC hygiene.
   These are happening anyway. After this, profile with the
   instrumentation in §"Confirmation plan" and listen.
2. **If still galloping after Tier 1, try Tier 2 (Bun).** Cheap
   experiment. Measure same metrics on Bun. If Bun is materially
   better, switch the runtime, keep iterating on TS.
3. **If both Bun and Tier 1 don't bring it home, build Tier 3a.**
   Native sidecar scheduler. Months of work but preserves ergonomics.
4. **Tier 3b (full port) only if 3a is insufficient.** Accept the
   ergonomic cost. Plan a long migration window with both stacks
   running in parallel.
5. **Tier 4 only if you eventually want server-side synthesis.**
   Different project.

The ensemble galloping is reproducible without audience or hardware,
which is gold for profiling. We don't need a performance to test
hypotheses — a 2-minute ensemble session per change suffices.

## Open questions / unknowns

- **Magnitude of the GC hypothesis is currently a hypothesis.** Numbers
  from the instrumentation will either confirm or redirect the analysis.
- **Tier 1's actual impact** depends on where the allocations are in
  current code. A profile-guided pass could be small (few hundred lines
  of pooling) or larger (refactoring the dispatch path). Need to look.
- **Whether 3a is overengineering** depends on Tier 1 + Tier 2 results.
  May not be needed.
- **Performance during a real show, on real hardware, with N phones**
  may behave differently than ensemble single-process testing.
  Particularly: more clients = more WS handler invocations on the
  server = more event-loop pressure. Something the instrumentation
  should capture.

## References

- `memory/project_tick_paradigm.md` — the architectural plan for moving
  off the tick paradigm. Tier 0 lives there.
- `memory/project_audio_rate_status.md` — the longer-term endpoint
  (continuous boxes in worklet, audio-rate everywhere). Independent
  thread but adjacent.
- `dev_log.md` 2026-04-24 — earlier framing of the tick-rate band-aid
  and the senior-architect assessment of the scheduler refactor.

---

# Elegance as the dominant constraint

*Added 2026-05-02 after a senior-architect agent analysis. The fix tree
above answers "cheapest path to better timing." This section answers a
different, broader question: if architectural elegance were the top
priority, what shape would the system want to take, and what would that
cost in terms of the object regime and performance ergonomics?*

## What the current system already gets right

These are properties any redesign should preserve, not invent.

- **The `graph-core.js` unification is the strongest piece of
  architecture in the project.** One set of definitions for
  `evaluatePure`, `tickBox`, `handleBoxEvent`, `applyInletToState`,
  `deliverValueToInlet`. Loaded server-side via the CJS shim
  (`server.ts:66-77`) and browser-side as a global. The 2026-04-23
  unification structurally closed a recurring bug class.

- **The zone system (`ctrl`/`synth`/`router`/`any`) is a clean partition
  of physical reality into a logical one.** Modeling the
  server-phone membrane as a typed object rather than as plumbing.
  Routers being their own zone makes the cross-membrane crossing
  visible.

- **The box-type registry in `gpi-types.js` is the right shape of
  declarative truth.** Inlets, outlets, port types, zones, dynamism,
  hot-inlet annotations, `firesEvent` semantics — listed once, in one
  literal. The registry drives editor port colours, propagation
  dispatch, audio topology builds simultaneously. The patch language
  *is* this file.

- **Hot/cold inlets + value/event split + two-phase propagation
  (2026-04-04 refactor).** The shift from "Pd-ish heuristics" to a real
  semantics. Inlet 0 hot, others cold-store; values arrive before
  triggers fire (deferred-events array in `eval-engine.ts:412-512`).

- **Audio worklets are honestly black boxes.** `ks-processor.js`,
  `ewing-processor.js`, etc. are isolated DSP modules with parameter
  descriptors and a port message for events. Cleanly layered. Whatever
  happens to the server, the worklets are unaffected.

## Existing architectural tensions

The seams. Some unavoidable, some accidents.

- **TS/JS split inside one runtime.** `server.ts`/`eval-engine.ts` are
  TypeScript; `graph-core.js`/`gpi-types.js` are plain JS loaded as
  text. The CJS shim and the `// deno-lint-ignore no-explicit-any`
  casts (`eval-engine.ts:19-37`) are the tax paid for the unification.
- **Dynamic value polymorphism on cables.** `BoxValue = number |
  number[] | string` (`patch-state.ts:15`). Doing real work
  (`held → assign → mtof` requires array travel) but makes any move
  toward static typing painful.
- **The tick paradigm is a known compromise.** `setInterval(tick,
  1000/240)` quantizes everything to a grid; competes with GC for the
  event loop.
- **Per-instance non-determinism is uncontrolled.** `Math.random()` at
  construction in `range`, `drunk`, `seq shuffle`, swarm/ewing per-frog
  parameters. Every reload is sonically different. Sometimes feature,
  sometimes bug. No seeded-randomness story.
- **Hardware integration is heterogeneous.** Monome via OSC, MIDI via
  Web MIDI on ctrl, ending up in different parts of the system.
- **The captive portal exists because the network refuses to be
  elegant.** Not in the object regime question but an anchor — any
  redesign that breaks first-tap-to-audio is dead on arrival.
- **Routers carry implicit semantics behind one-word names.** `one N`
  bundling, `assign` stable matching, `group` membership — sophisticated
  behaviours, each a server-side special case in `handleRouterInlet`.
- **A few special cases haven't migrated to the registry.** `length`
  (`eval-engine.ts:490-495`), `breath`/`bite` two-outlet propagation
  (`:340-347`), `seq` inlet-2 array preservation. Almost-uniform
  dispatch but not quite.

## Configurations of the system, evaluated

Five plausible system configurations against the elegance dimensions.

### A. Status quo + scheduler refactor + GC hygiene
Minimum disturbance. ~80% of the timing problem solved. Single source
of truth preserved, live-edit speed unchanged. The tick paradigm
shrinks but doesn't disappear (integrators still need a cadence). The
object regime stays heterogeneous. *Elegance-by-deferral* — the system
doesn't get more coherent, it just gets less audibly broken.
Iteration cost: 0 sec. Internal coherence: high (nothing structural
changes).

### B. Hybrid — TS server + native sidecar scheduler
Small (~500 LOC) Rust/Go process holds the heap of pending events,
fires WS sends at exact wall-clock times. TS computes "fire X at T,"
sidecar does the firing. Outbound timing immune to V8 GC. Most
architecture unchanged. Now the project is bilingual but with a small
seam doing a distinct job. Inbound (OSC, MIDI, ctrl WS) still
GC-subject, but at chord/metro scale that's much less audible.
Iteration cost: 0 for graph/patch work; sidecar rebuilds-per-change
but you almost never touch it. Internal coherence: medium —
*pragmatically elegant.*

### C. Single-runtime native (Rust server, JS worklets)
Rewrite server-side in Rust. Worklets stay JS in browser. Either
re-implement graph dispatch in JS for the browser (re-opens the
unification bug class) or compile the Rust graph-core to WASM (then
this is really D below). Without WASM-everywhere, this is the *least*
elegant option — re-opens the dispatch divergence. Iteration cost:
5–30 sec rebuild per server-side change. Internal coherence: depends
entirely on whether you go to D.

### D. WASM-everywhere graph engine
Rust crate (or Zig, AssemblyScript, etc.) implementing
`gpi-types` + `graph-core` semantics. Compiled to WASM. Loaded on
Deno server *and* synth/ctrl browsers. Worklets stay JS. Patch JSON
stays JSON. The engine exposes a small API: `apply_patch(json)`,
`inject_value(boxId, inlet, value)`, `inject_event(boxId, inlet)`,
`tick(dt)` returning `(messages, ui_updates)`.

This is the most architecturally elegant option that exists in this
design space. Same compiled bytes running on both sides, not "same
source text via shim." GC eliminated in the graph engine. Static types
throughout, dynamic `BoxValue` confined to one `enum`. Hot path
deterministic. Browser and server are *symmetric*.

Costs: WASM↔JS marshalling at the edges (worklet messages, MIDI, OSC)
costs a small per-crossing amount. Engine internals become Rust —
verbose, build step, dynamic-feature pain. Non-graph server work (TLS,
captive portal, file serving, OSC, MIDI plumbing) still lives
*somewhere* — probably still Deno/TS calling into the WASM module. So
two languages, but with a *principled* split: I/O and infrastructure
in TS, graph semantics in Rust→WASM. Live-coding the engine itself is
slow (Rust rebuild). Live-coding patches is unchanged (patches are
JSON; WASM doesn't get rebuilt). *This is the right tradeoff* — the
engine should be stable, patches should be fluid.

Iteration cost: patches 0 sec, engine internals ~10 sec
rebuild+reload, worklets 0 sec. Internal coherence: highest. This is
what "elegance" actually points at if single-source-of-truth is the
dominant value.

### E. Constrain the patch language to fit a typed runtime
A *language-side* tightening, independent of which runtime hosts it:
- Cables carry one type, fixed by the outlet (mostly true already; just
  enforce). No null/array/number polymorphism on the same cable.
- Static graph topology after apply — no runtime structural changes.
- All randomness seeded per-box at apply-time from `(boxId, instance)`.
- Wireless boxes (`s`/`r`/`throw`/`catch`) compiled at apply-time into
  direct cables. *Patch-time* convenience, not *runtime* feature.

Makes the patch language *inspectable* in a way it isn't today. After
apply, you have a static graph with typed cables and deterministic
randomness. Reproducibility across runs becomes free. Translating to a
typed runtime becomes mechanical instead of edge-case-laden. *Worth
doing on its own merits regardless of any runtime decision.*

## Restrictions elegance would actually demand

Ranked by severity (severity = how much it changes what the system
*feels like* to use).

**Severe — would change what the system is for:**
1. **Static graph topology after apply.** Patches finalize at
   apply-time; runtime structural changes go away. *Probably absorbable
   — the project already operates "edit, apply, listen."*
2. **A compile step in the engine iteration cycle (D).** Patches stay
   JSON (no compile). Editing graph-core internals becomes a Rust
   rebuild. *Absorbable iff the engine should be fundamentally stable.
   Honest gut-check: how much have you been changing graph-core.js
   recently? If lots, this hurts.*
3. **Single representation per cable type.** Either cables are typed
   and runtime values match, or one tagged union everywhere. *Absorbable
   — cables are already typed in the registry.*

**Moderate — would feel different but not break the project:**
4. **Seeded determinism.** Replace every `Math.random()` at construction
   with `seededRng(boxId, instance).next()`. Add a "scramble seed"
   performance affordance and you've lost nothing, gained reproducibility.
5. **Routers as first-class scheduler citizens.** Each router type a
   small object with uniform interface, instead of long if/else in
   `handleRouterInlet`. Easy refactor.
6. **Hardware bridges as graph entry points, uniformly.** OSC and MIDI
   converging on the same shape. Mostly tidying.

**Mild — already mostly true, just tightened:**
7. **No special cases in dispatch.** Move `length`, `breath`/`bite`,
   `seq` inlet-2 into the registry as declarative metadata (extends the
   `project_inlet_dispatch_table` plan).
8. **Wireless flattened at apply-time.** `s`/`r`/`throw`/`catch` rewritten
   into cables at apply. Loses some "global namespace" feel; may not want.

**Don't-do (would break the iteration story):**
- AOT-compiled patches. Patches must remain JSON.
- Loss of worklet hot-reload. Don't touch this.

## Recommendations

### If elegance is the top priority

**D + E.** WASM graph engine + tightened patch-language semantics.
Concretely: a Rust crate (`graph-engine`) implementing `gpi-types` +
`graph-core`, compiled to WASM, loaded on the Deno server and on
synth/ctrl browsers. Worklets stay JS. Patch JSON stays JSON.

This collapses "two runtimes that share source text" into "one runtime
that genuinely runs in two places." Eliminates GC from graph
evaluation. Forces the patch language to clarify itself. Doesn't
change what the system is for; preserves the two iteration loops that
matter for composition (worklets, patch JSON).

Cost honestly: ~3 months of focused work. The engine is small (~1200
lines of graph-core.js, plus the registry data) but careful porting is
slow. During the port the system has two engines running in parallel
with subtle behavioural drifts to chase. WASM ergonomics in 2026 are
mature but not friction-free.

Why not C (Rust everywhere): non-graph server work (TLS, captive
portal, file serving, OSC, watch-and-reload, MIDI plumbing) is fine
where it is. You don't need Rust there.

Why not B (sidecar): fixes the symptom but leaves the architecture
less coherent than D. Two languages doing two jobs is worse than one
engine running in two places.

### If you also want to keep iterating fast

**A + a lighter version of E.** Scheduler refactor + GC hygiene + the
patch-language tightening that doesn't require a runtime change:
- Seeded randomness everywhere.
- Lift `length`, `breath`/`bite`, `seq` inlet-2 special cases into
  the registry (extends `project_inlet_dispatch_table`).
- Tag wireless as apply-time-resolvable in the registry (mark, don't
  flatten yet).

This buys most of the *legibility* benefit of D without the runtime
cost. The system feels more coherent without changing what it is.
Iteration speed unchanged. If you later decide to go to D, the language
work is already done — porting becomes mechanical.

Cost: ~2-3 weeks of focused work. Zero iteration cost. Zero conceptual
disruption. **This is the practical recommendation given that you're a
composer who needs to make pieces.** D is for a winter sabbatical.

## Things still unknown

- **How often `graph-core.js` actually gets edited vs. just patches.**
  If frequent, D's iteration tax bites harder. If rare (engine mostly
  stable, patches molten), D is genuinely cheap.
- **Whether the GC hypothesis holds when measured.** The instrumentation
  in §"Confirmation plan" tells us. If GC isn't the dominant clumping
  source (could be Deno's WS implementation, a propagation hot path, or
  audio thread contention on the Mac Studio), the runtime-driven case
  for B/C/D weakens.
- **Whether the project will want server-side audio synthesis later.**
  If yes, a WASM graph engine doesn't help; you'd want a native
  sample-rate-aware host. C becomes more justified.
- **How strongly hot-loaded abstractions matter going forward.** Today
  they exist (the `inlet`/`outlet` interface boxes). If you head toward
  more dynamic abstraction, D's compiled-engine model makes that harder.
- **Real performance envelope at scale.** Single ensemble Mac Studio is
  the test today. With 100+ phones in performance, what looks like a
  GC problem might turn out to be a connection-fanout problem.

## Pushback on the question itself

The framing assumes elegance has a single optimum. It doesn't, because
two of the elegance dimensions actively pull against each other:

- **Conceptual unity** (single source of truth, one runtime story)
  pushes toward D.
- **Iterativity** (composition-while-coding) pushes toward A or B.

A system that prioritizes both equally will look compromised — that's
not the system's failure, that's the geometry. The honest framing is:
"I'm willing to spend N weeks/months in exchange for K% more
coherence." For small N: A + light E. For large N + willingness to slow
engine iteration: D.

The current architecture is closer to optimal than the timing problem
makes it look. The unification at `graph-core.js`, the zone partition,
the box-type registry, the value/event split — these are good bones.
**The timing issue isn't an architectural failure; it's a runtime
accident that the architecture happens to be sensitive to. Don't burn
down the building because the boiler is loud.**
