# GPI — Design Principles

*Status: living document, prototyping stage. This describes the conceptual model GPI
is **converging toward**, not a finished spec. Where the code today contradicts a
principle, a **Where the build stands** note marks the gap — and the gap is the *work*, not
an error in the doc. Those notes deliberately stop at "the model says X, the build does Y";
the code-site detail and the plan to close each gap live in the companion `gpi_migration.md`,
which is execution backlog, **not** audit material.*

---

## 0. Why this document exists

GPI's conceptual model has, until now, lived only in one head and is half-contradicted
by its own implementation. This document writes it down, for three reasons:

1. **To stop re-deciding the foundations.** Several "2am questions" (should ctrl-side
   envelopes be audio-rate? should we keep the GPI animations? do we need a third
   zone? is the server tick right?) turn out to be the *same* question seen from
   different sides. Naming the model once settles them as a set.
2. **To put the commitments themselves on trial.** Any auditor — human or model — will
   otherwise measure GPI against generic norms. The point of GPI is not to be generic; it
   is to be a *particular* under-determined instrument in a particular lineage. So the
   question this doc invites is not whether the code is generically good, nor even whether
   the code is *faithful* to these principles (that fidelity work is execution — see
   `gpi_migration.md`), but whether the principles **themselves** carve the instrument at
   its joints. The doc states them concretely enough to be attacked at that level.
3. **To be forkable.** A does-nothing *medium* that invites others to build *inside* it
   must be legible at the level of *why*, not just *how*. This is the why.

### Lineage and registers

The practitioners below are **not co-equal lenses**; they answer *different kinds of
question*, and keeping the three registers straight is the framing this document commits to.

- **What it is** — *Puckette.* The spine. Pd is the model: a **does-nothing *medium*** —
  a small set of primitives plus a patching rule, expressively closed so you build the
  whole instrument *inside* it, rather than dropping a component into someone else's
  assemblage. Pd's message/signal cut is GPI's deepest inheritance; the cardinality border
  (§§1–2) is that cut run across a *one → many* distribution. One line: **GPI is Pd's
  completeness plus one new axis — cardinality.** Within this register, *McCartney* supplies
  the **rate** vocabulary (`ar`/`kr`/`ir`/`dr`; demand rate is his, §4) and *McLean* the
  **agnostic-middle** scope — the distribution core is targetable by more than the box
  editor, so a future live-coded front-end is a peer (§6). Liveness per se is **not** a driver.

- **Why it takes *this* shape** — *the apparatus.* The principles are answerable to the
  material affordances of the browser / wifi / server, not deduced from a poetics. The
  border rule is wifi forcing the message/signal cut; cardinality is *one laptop, N
  uncontrolled phones*; display = observation is an epistemic limit of the substrate. A
  working distinction falls out: affordances the instrument **exploits as material** (wifi
  divergence between phones — *constitutive*, the artwork itself) versus accidents it merely
  tolerates (V8 GC — measured at ~1 ms, so not even that; see
  `server-timing-runtime-analysis.md`). The paradigm must say which is which.

- **Why it's worth making this way** — *Crabtree (monome).* The ethical/poetic register,
  and **deliberately the quietest of the three** — resonance, not spine. The does-nothing
  ethic survives, but relocated from *object* to *medium*: monome's grid does-nothing by
  being radically *incomplete* (it demands an assemblage); GPI does-nothing the way an empty
  Pd patch does — *complete but unfilled*. The pull toward fewer concepts and a smaller core
  is real and worth honouring (§1 weak point), and the forkability/teachability case for the
  lines release lives here. When the question turns pragmatic, Simondon's *open machine* — a
  technical object "endowed with indetermination," sensitive to its milieu — is the apter
  anchor than Crabtree's whimsy.

When these registers pull against each other (and they do — §1 weak point), the conflict is
named rather than hidden.

---

## 1. Two axes, not zones

**Principle.** A box has two independent properties. They are orthogonal and must not be
conflated:

- **Cardinality** — `one` (the laptop / ctrl client) or `many` (the phones). This is
  what the *synth border* on the canvas actually divides.
- **Rate-domain** — `event`, `control`, or `audio`. This is Puckette's message/signal
  cut, refined by a middle term.

The grid these axes describe:

|                | event                  | control (k-rate)         | audio (a-rate)              |
|----------------|------------------------|--------------------------|-----------------------------|
| **one** (ctrl) | router fire, `key`     | `adsr` driving a router  | ctrl-side `sine~`, `adc~`   |
| **many** (synth)| trigger to phones     | `adsr` on a phone        | phone `sine~`               |

**Where the build stands.** The word **"zone" currently fuses these two axes** (`ctrl` /
`synth` carry cardinality; audio-ness leaks across as an ill-fitting third thing). The
code already half-separates them — `zone: "any"` means *cardinality-polymorphic*, and
the `~` suffix already encodes *rate* independent of side. The target is to complete
that thought: a box declares a **cardinality** (one | many | any) and a **rate-domain**
(event | control | audio), and "zone" as a single fused label retires.

**What this dissolves.**
- *"Do we need a third zone for the ctrl client doing real work?"* No. `one` is a full
  citizen of all three rate-domains, exactly like `many`. The ctrl client already runs
  audio worklets and has live I/O (`adc~`/`dac~` in `ctrl.js`). "ctrl as a doer" is not
  a new zone; it is a cell of the grid that was always there.

**Weak point (state it for the audit).** The grid is more *correct*, but Crabtree-
minimalism asks whether it is more *simple*. Two axes is two concepts to teach where
"zone" was one. The audit should press: is the grid earning its keep, or is a cruder
single concept truer to the does-nothing ethic, even at the cost of the edge cases it
fumbles?

---

## 2. The border rule

**Principle.** The cardinality border (`one` ↔ `many`) passes **event** and **control**
only. **Audio never crosses.** You cannot ship a sample stream to 100 phones over a
WebSocket, and the attempt is not a missing feature — it is a category error.

Therefore audio that must cross does so by a forced pair of rate-crossings:

> **analyse** (audio → control) on the source side → cross as control → **synthesise**
> (control → audio) on the destination side.

Analysis and synthesis are the legal transitions *between* rate-domains within a
location. The border is legal *only* in the control/event lane.

**Worked example — the distributed panharmonium.**

> mic → `adc~` *(one, audio)* → **FFT → 33 peaks** *(one: a-rate → k-rate)* → cross the
> border as control → phones resynthesise *(many: k-rate → a-rate)*

This is not a special case to be bolted on. It is the border rule *demonstrating
itself*: audio crosses precisely because it was analysed first. The feature needs **one
new box type** (an FFT→peaks analyser, an a→k worklet on the `one` side) — not a new
zone and not a protocol change. Routers already carry arrays.

**Where the build stands.** Honoured today: routers carry events and instant values, never
continuous interpolation (README, "the border rule"). The target only makes the
*reason* explicit — that this rule is what makes analysis-to-cross the canonical path
for signal material, and that smoothing therefore always lives on the side the engine
lives on.

---

## 3. Display = observation

**Principle.** The editor shows **observed** values. It never **simulates** them. A box's
displayed motion is a *sampling of the truth* reported by whatever actually rendered it
— not a second, divergent re-computation on the server.

Corollary: **animation is not a computational rate.** It is the rate of *observation*
(~30 fps), strictly downstream of event/control/audio, and **causally inert** — it may
never feed back into behaviour. Treating "animation" as a third rate alongside
audio/control is the category error that made these questions feel unstable.

**What this resolves.**
- *Above the border:* the ctrl-side worklet self-reports its output value to the editor.
  One real number — the actual envelope. (Co-located; cheap.)
- *Below the border:* designate **one probe phone** — a "monitor" client — and stream
  *its* real values up. Show the truth of one synth, labelled as one synth, never a
  fiction of all N. The `uplink` / synth→server channel is the substrate.

There is a thesis-shaped bonus: the editor stops *pre-rendering* the audience and starts
*listening back* to one of them. Observation over the view-from-nowhere.

**Where the build stands.** The build today does the *opposite* of this principle: it
*simulates* ctrl-side envelope shapes on the server purely to draw them — a cosmetic
re-computation the audio never consumes. So the principle currently describes where GPI
should stand, not where it stands. *How* to close the gap (delete the cosmetic layer;
self-report from worklet/probe) is execution — see `gpi_migration.md`. The question for the
audit is whether the principle itself is sound: is "never simulate, only sample the truth" a
law worth enforcing, or does it forbid legitimate cases (e.g. a box with no live renderer yet)?

---

## 4. Push / pull / clock — the temporal model

**Principle.** A value can come into being over time in exactly three ways. GPI names
all three and prefers the first two:

- **Push (event-driven).** A change propagates forward when it happens.
  *(`propagateAndNotify` — already correct, needs no clock.)*
- **Pull (demand-driven).** A consumer asks on a trigger, and the value is computed
  *then*. This is the entire value-on-trigger family — `seq`, `counter`, `drunk`, `sig`,
  `sample-hold`, `range`, `random`, `select`, `swap`, `trigger`. They already pull. This
  is McCartney's demand rate; GPI just hadn't named it.
- **Clock (sampled).** A value advances with wall-clock time, sampled at a fixed rate.
  *(The 240 Hz `tick()` — the only place GPI eagerly **polls**.)*

**The target: the server polls nothing.** It **pushes** on change, **pulls** on demand,
and **clocks only its metros**. The poll dissolves:

- Time-continuous *signals* (`lfo`, envelopes, smoothers) → **into worklets**, where the
  `process()` callback *is* a demand pull (the audio thread demands the next block). This
  is the same move as "signals live in worklets" (§2). It kills the zipper, removes the
  network hop, and removes the box from the tick — three problems, one move.
- *Value-on-trigger* boxes → already pull; unchanged.
- *Metros* → the genuine clock **sources**, but each is one scheduled timer, not a reason
  to poll every box at 240 Hz.
- *Border-crossings* → the border rule (§2) already forbids continuous streams across,
  so anything crossing is demand-sampled on a trigger. **The one case that would require
  polling is already illegal.**

**Where the build stands.** Push and pull already exist and behave correctly; the eager
240 Hz poll is the residue that contradicts "the server polls nothing." Shrinking the tick is
execution (`gpi_migration.md`). The audit question is the model's, not the code's — see the
weak point below.

**Weak point (state it for the audit).** Demand rate is conceptually clean but **leans on
a timing story GPI has not told yet** — how metros schedule precisely against the audio
clock, given JS timer jitter (the Web Audio "two clocks" problem). That is the
sync/latency conversation, deliberately parked (§7). The audit should note that this
principle is *sound in model but owes a debt to a sync design that doesn't exist yet*.

---

## 5. Deterministic propagation (two-phase)

**Principle.** When a cable updates, values arrive at *all* relevant inlets **before**
any trigger fires. Because values settle before triggers, cables may be drawn in any
order and behaviour is deterministic — GPI does not need Pd's right-to-left ordering
convention. (See the snapshot tests under `tests/`.)

**Where the build stands.** The guarantee is implemented but **local to a single outlet's
fan-out**, not global across the whole propagation. Re-entrant propagation is depth-first,
and there is **no cycle guard** on the main propagation path (unlike the router-trace path,
which has one). So "any order, deterministic" holds for the immediate fan-out, but cycles are
prevented *by convention, not by construction*. The exact code sites are in
`gpi_migration.md`; the audit question is the weak point below.

**Weak point (state it for the audit).** Either prove cycles cannot affect determinism,
or make the two-phase guarantee global. This is the corner currently avoided rather than
closed.

---

## 6. The composition surface is separable from the distribution core

**Principle.** The "middle" GPI occupies is itself two layers:

- an **authoring surface** that *produces* events and control values — today: typed boxes
  + cables; conceivably tomorrow: a Tidal/Strudel-style pattern language;
- a **distribution core** that *routes* them across the cardinality border to agnostic
  outputs — the border, routers, the client protocol.

Distributed Synthesis is agnostic on its **input** and **output** ends, both scoped only
by browser-API affordances. The same under-determination should extend to its
**authoring** end: the box editor is *one* front-end, not the definition of the system.
This is McLean's real lesson — Tidal stays agnostic about what renders it; GPI's
distribution core should be targetable the same way, so a box patch and a future
live-coded Strudel front-end are **peers** that both emit into it.

This is also why **liveness is not a GPI design driver.** Live coding, if it comes,
arrives as an *alternative front-end* targeting the distribution core — not as a property
GPI itself must have.

**Where the build stands.** Today the server both evaluates boxes *and* routes across the
border — the two layers are entangled. Whether to name the seam (*a front-end produces an
event/control stream; the core distributes it*) is execution, and explicitly a
**door-open-only** call (`gpi_migration.md`) — premature separation is its own failure. The
audit question is the narrow one in the weak point below.

**Weak point (state it for the audit).** This is a **door to keep open, not a thing to
build now.** Premature separation is its own failure — YAGNI, and against the
break-loudly prototyping ethic. The only audit question is narrow: *does anything in the
current box↔core entanglement actively foreclose a second authoring front-end?* If not,
leave it entangled and revisit when Strudel is real.

**Crabtree resonance.** Under-determination now covers all three faces — input, output,
*and* authoring. The instrument refuses to predetermine what you compose with, as much as
what you play it with or what it sounds like.

---

## 7. Parked: sync & latency

Out of scope for this document **by choice** — but two parked questions share one seam,
which is worth recording:

- *When exactly does a metro fire?* (§4)
- *When exactly does a phone apply panharmonium frame N relative to its neighbours?* (§2)

Both are "when precisely does a timed event happen." That they are the same shape is a
strong hint that GPI's eventual sync model has **one** structure, not many — and that
the demand-rate temporal model (§4) and the analysis-to-cross border rule (§2) will both
cash out against it when it's opened.

---

## Appendix A — Box temporal taxonomy

A claim about how GPI's boxes partition by *how a value comes into being over time*
(grounded in `handleBoxEvent` / `tickBox` in `graph-core.js`). The partition is itself
auditable: do these three classes carve correctly, or is the **hybrid** row a smell — a sign
the push/pull/clock model (§4) doesn't cleanly fit the boxes that have both an event onset
and a clocked tail?

**Pure demand (pull on trigger; no clock needed).**
`seq`, `range`, `drunk`, `counter`, `sample-hold`, `random`, `const`, `toggle`, `fan`,
`held`, `pad`, `trigger`/`t`, `select`/`sel`, `swap`.

**Clocked / time-evolving (currently polled by `tick()`; migration candidates).**
`lfo`, `phasor`, `metro`, `ar`, `adsr`, `ramp`, `step`, `sigmoid`, `cosine`, `slew`,
`lag`, `inertia`, `follow`.

**Hybrid (event onset, then clocked evolution).**
`ar`, `ramp`, `step`, `sigmoid`, `cosine`, `phasor`, `delay` — triggered by an event,
then advanced by the tick. These are the ones whose `~` audio siblings already exist;
their migration target is "render in the worklet, demanded by `process()`."

---

## Appendix B — Execution backlog (moved)

The migration map, the per-principle code-site index, and the name-dispatch residue list now
live in **`gpi_migration.md`**. They are deliberately **not** audit material: closing a
*Where-the-build-stands* gap is the grind that follows *once a principle is accepted*, done
in-session or via workflow — not Mythos's work. One claim from that backlog is load-bearing
*here*, though, because it bears on Principle §0.3 (forkability): until the hardcoded box-name
dispatches in the engine are folded into the existing per-box vtable, a workshop participant
cannot add a stateful or event box without editing the engine core — so GPI is **not yet
forkable** in the way §0 claims. That gap is fair game for the audit; the line-by-line plan to
close it is not.

---

## Open questions for the audit (the attackable claims)

Hand these to a fresh, strong, independent reviewer — *to break*, not to rubber-stamp.
Each carries its own stated weak point above.

1. **Is the two-axis grid (§1) right, or over-engineered?** Does does-nothing minimalism
   prefer a cruder single concept even at the cost of edge cases?
2. **Should GPI keep two envelope families** (control-rate + audio-rate `~`), collapse
   them, or make `adsr`-the-control-box a thin shell over `adsr~`? (This is §1 + §4
   together — "where do signals live, and who renders them.")
3. **Can the server tick truly dissolve to demand + scheduled clocks (§4)** without a
   sync model in hand — or does demand rate owe a debt it can't yet pay?
4. **Two-phase determinism (§5):** prove cycles are safe, or make the guarantee global?
5. **Front-end seam (§6):** does anything in the current box-evaluation↔distribution
   entanglement *foreclose* a second authoring front-end (e.g. a live-coded Strudel
   layer)? Door-open check only — not a call to build the abstraction now.
6. **The recurring McCartney pattern.** Twice the technical answer (rates, demand) routed
   through the practitioner the author is most ambivalent about. Likely an M3
   *Confluences of Practice* point, not an audit finding — but flagged here so it isn't
   lost.
