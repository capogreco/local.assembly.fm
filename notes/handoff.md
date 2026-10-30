# Session handoff — 2026-10-30

This is for a fresh Claude session on another machine. Memory files don't
travel between machines, so this note carries what they held. Internal; replace
it at the next handoff.

## State

The branch is `docs/tambourine`. `main` is the previous working version and the
gig fallback. Don't merge into main until Thomas says so; the plan is after the
gig.

The single-evaluator step is **done**: stages A–D, plus the fixes from two
Fable reviews. The server now evaluates the one side with the phones'
`public/graph.js` / `graph-core.js`, and routers are its sinks.
- Laptop audio is deployed over the ctrl socket (`deploy.ts`:
  `serializeLaptopPatch`) and built from the server's expanded graph.
- `emit()` is the only exit for `rv`/`re`.
- One `replay(to)` serves both phones and the laptop.
- `deno task test` runs four suites: phone snapshot, server snapshot,
  side_binding and deploy. All pass.

Checked by Thomas, on the browser and the ensemble client:
- panharmonium: nothing below 100 Hz.
- ks_arp: the arp descends, as wired (`sort desc`).
- frogs: pads work. The MPK must be in note mode, not CC.
- epimetheus: uplink and swarm work, after the patch fixes below.
- Editor: nudges into the border are refused.

**Still to check, on phones from the laptop:**
- epimetheus pad 39 → `delay 0.1 → one` must advance **exactly one** phone
  per hit (the ensemble can't show this).
- Editor:
  - an off-side bound box can be dragged home;
  - a move is refused only if it *newly* takes an audio cable across the
    border;
  - hold ↓ on `key` stops at the line;
  - Shift+↓ is refused;
  - a free box crosses;
  - a border drag pushes `key`;
  - paste and text commit snap.
- Keep one ctrl tab open: each tab builds laptop audio and grabs the mic.

Patch fixes made during testing (committed):
- epimetheus:
  - `touch` outlets 1 and 2 now go to `sendup` (only `tx` was sent before);
  - `screen 10` → `screen`, so the text layer (z 2) sits above it.
- frogs: an extra `print` on `key 10`.

## Things to know

- **ks_arp arp phase.** Each `one 4` fire now carries the note `seq` just
  produced. Before Stage B it carried the previous one. Accepted.
- **Ctrl reload during panharmonium.** Phones hold their last note until the
  first click or key on the ctrl page; the page says so.
- **A throw in server evaluation** is reported to ctrl, rate-limited, and the
  server keeps running. A batch is capped at 1000 flush rounds. A failed build
  leaves no graph and doesn't report "applied".
- **ctrl.js MIDI auto-create** (around ctrl.js:748) places boxes with no side
  check, which is how ks_arp got off-side boxes. It should call `placeOnSide`.
  Not fixed yet.
- **Server box display shows outlet 0.** So `held` shows its array, and
  `fftPeaks~` shows nothing.

## Decisions (Thomas)

- **D1.** An event passes `passthrough` and `event` inlets and is dropped at
  `number` inlets. The rule reads the port type, not an exception list.
  `spigot` is retyped to passthrough and `sendup` to number.
- **D2, reversed.** `sall` reaches phones only, not one-side `r` boxes. Feeding
  them made a feedback loop that froze the server.
- **D3.** Joining phones get a replay only for `all` and `sall`.
- **D4 / D7.** The envelope flashes and ramp~ animation are drawn by the ctrl
  page. The server's 240 Hz tick stays as the evaluation clock, and the
  metro-phase display comes from the metro's state. The tick paradigm itself is
  still an open question.
- **Phone semantics win:** `phasor once` stays finished, `delay` fires once,
  `seq` inlet 1 takes a string.
- **Side rule.** A bound box (one/many) must sit wholly on its side, and
  overhanging counts as off side. Only routers (`border`) straddle the line. A
  free box is sided by its centre. The rule lives only in
  `public/gpi-types.js`, shared by the editor and `apply-check.ts`. Editor
  moves are judged by where the box ends up, so an off-side box can be moved
  back.

## How Thomas works

- **Agent split.**
  - A Fable agent is the read-only reviewer and researcher.
  - An Opus agent does the code work, in a worktree made by hand off
    `docs/tambourine`. Agent worktree isolation branches from main, so don't
    use it.
  - The main thread keeps the discussion. Don't do code work inline when the
    implementer can take it.
- **Rhythm.**
  - Fast-forward `docs/tambourine` once the implementer's tests pass, so
    Thomas tests from his main checkout.
  - Queue obvious small follow-ups without asking; ask only about real design
    decisions.
  - Give one test list per merge.
- **Servers.** Agents don't start servers; Thomas runs his own.
- **Runtime and stage.**
  - Deno now, Bun later, never Node.
  - Early prototyping: no backwards compatibility, fail loudly.
- **Writing.** Thomas hand-writes all public-facing prose. `notes/` is internal,
  so editing it factually is fine.
- **Commits.** End messages with a `Co-Authored-By: Claude …` line.

## Next and parked

- **Next:** Thomas designs the instrument for the 2026-10-31 performance.
- **After the gig:**
  - merge to main;
  - per-voice ensemble viewport tiles (see `network-and-modes.md`, Rung 0a);
  - the ctrl.js auto-create side fix;
  - the Bun swap.
- **Network.** Bringing the GL.iNet Beryl AX instead of the Fritzbox, GS305PP
  and two U6+ is under consideration. The estimate is 30–60 phones comfortably;
  it's untested for this setup. Check the subnet vs the laptop's static IP, DNS
  for `local.tamb.fm`, and SSID/QR before relying on it. See
  `network-and-modes.md` and `openwrt-router.md`.
- **Parked:** laptop DNS decoupling, salvaged network hardware, and the 240 Hz
  tick paradigm.
