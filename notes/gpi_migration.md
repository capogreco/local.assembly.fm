# GPI — Migration Backlog (execution)

*Companion to `gpi_principles.md`. This holds the **execution/grind** half that the
principles doc deliberately sheds: code-site coordinates, the name-dispatch residues, and
the per-box migration classification. It is **not** audit material — by the standing rule,
Mythos is reserved for high-level architectural judgment, and this is the work that follows
**once a principle is accepted**, done in-session or via workflow.*

*Each entry is keyed to the principle (`gpi_principles.md` §N) whose Today→Target gap it
closes.*

---

## Code-site index (per principle)

**§1 — two axes, not zones.** "zone" currently fuses cardinality and rate-domain; `zone:
"any"` already means cardinality-polymorphic and the `~` suffix already encodes rate
independent of side. Target: a box declares a **cardinality** (one | many | any) and a
**rate-domain** (event | control | audio); the fused "zone" label retires. Overlaps the
name-dispatch fold-in below.

**§3 — display = observation.** The server re-simulates ctrl-side envelope shapes at 240 Hz
purely to draw them: `ctrlAudioAnims` / `ctrlAudioTrigger` (`eval-engine.ts:692–722`), with a
hardcoded `trig~/ramp~/ar~/sigmoid~/cosine~/step~` list the audio never consumes. Target:
delete the server-side cosmetic layer; replace display feedback (where wanted) with
worklet/probe self-reporting. Also removes a name-dispatch residue (below).

**§4 — push/pull/clock.** `tick()` polls all stateful ctrl-side boxes at 240 Hz
(`eval-engine.ts:727`). Push and pull already exist and are correct; the clock-poll is the
residue. Target: shrink the tick to metro scheduling; migrate the time-evolving family into
worklets (demand) or onto event-scheduled timers.

**§5 — two-phase determinism.** Implemented but **local to a single outlet's fan-out**
(`eval-engine.ts:510–511`, the deferred-event queue), not global across the whole
propagation. Re-entrant propagation (e.g. `length` recursing, `setBoxValueAndNotify` chains)
is depth-first, and there is **no cycle guard** in `propagateAndNotify` (unlike
`traceToRouters`, which has one). Target: prove cycles cannot affect determinism, or make the
two-phase guarantee global.

**§6 — composition surface / distribution core.** The server both evaluates boxes *and* routes
across the border (`eval-engine.ts`). Target (door-open only): name the seam so the
distribution core accrues no box-editor dependencies that would foreclose a second front-end.
Do **not** build the abstraction now.

---

## Migration map

Closing the gap between Today and Target is mostly **closing the box-extension surface**:
folding hardcoded box-name dispatches in `eval-engine.ts` into the per-box vtable that
already exists (`createBoxState` / `applyInletToState` / `tickBox` / `handleBoxEvent`).
Until this is done, a workshop participant cannot add a stateful or event box without
editing the engine core — so GPI is not yet forkable in the way Principle §0.3 claims.

**Name-dispatch residues to migrate (each → a box-module method or registry flag):**

- `handleStatefulInlet` (`eval-engine.ts:762`) — switches on `phasor`, `metro`, `adsr`,
  `sample-hold`, `seq`, `held`, `map`, `toggle`. → `applyInletToState`.
- `ctrlAudioTrigger` (`:692`) — switches on `trig~`, `ramp~`, `ar~`, `sigmoid~`,
  `cosine~`, `step~`. → **deleted entirely** by Principle §3 (display = observation).
- `tick()` smoother special-case (`:734`) — `slew`/`lag`/`inertia`/`follow`. → worklet
  (demand) per §4.
- `setBoxValueAndNotify` breath/bite gate (`:340`), `length` special (`:490`), `seq`
  inlet-2 preservation (`:480`) — "pre-helper" cases the comments already flag as
  awaiting fold-in to the shared `deliverValueToInlet`.

**Classification target for each clocked box** (`gpi_principles.md` Appendix A, list 2):
`→ worklet (demand)` · `→ event-scheduled clock` · `→ genuinely-must-remain-server`.
Producing this per-box decision is the migration's first concrete pass.
