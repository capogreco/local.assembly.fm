# Session handoff — 2026-11-09

For a fresh Claude session, possibly on another machine. Memory files don't
travel between machines, so this note carries what they held. Internal; replace
it at the next handoff. (The 2026-10-30 version is in git history.)

## State

The branch is `docs/tambourine`, pushed at `5cd41b6`. `main` is still the old
working version (181 commits behind); don't merge into it until Thomas says so.

Built 2026-11-08, all Fable-reviewed and merged (design notes in brackets):
- **Grid** (`editor-modes.md`, "Grid"): half-unit positions, 20px boxes,
  ports drawn inside boxes, routers straddle the border, no other box crosses
  it, a box's zone comes from its type on commit, border drags push boxes and
  spring back. `l` nudges overlapping boxes apart (border fixed, zoom out only).
- **Router cables** (`architecture.md`): ctrl → router → synth is the only
  flow; router → ctrl, synth → ctrl, synth → router and router → router are
  refused in the editor and at apply. Knobs are ctrl-bound; fan, toggle and
  event stay free.
- **Abstractions** (`abstractions.md`): headers, libraries, faces, and
  encapsulate (Cmd+Shift+E), saved create-only (409 if the name is taken).
- **Samples and granular** (`samples-and-granular.md`): `buffer~`, `play~`,
  `hann~`, `samphold~`, `phasor~` reset and phase. Not `record~`.
- **Patches:** all but `faces_pitch-amp.json` and `granular_example.json`
  deleted from `patches/` (retrievable from git); test fixtures live in
  `tests/fixtures/`.

`deno task test` runs six suites, all passing.

**Still to check in a browser:** encapsulate. Select part of a synth-side
patch, Cmd+Shift+E, name it, check the instance's cables, double-click into
it, apply and listen; try a router in the selection, both zones, a taken name,
a double press. Undo restores the boxes but not the saved file: delete test
abstractions in `libs/` by hand. On Firefox under Windows or Linux,
Ctrl+Shift+E opens devtools and can't be blocked.

**Thomas will reword** all public-facing text, including the `l` help line
("L tidies the layout") and help for Cmd+Shift+E.

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
- **D2, reversed.** `sall` reaches phones only, not ctrl-side `r` boxes. Feeding
  them made a feedback loop that froze the server.
- **D3.** Joining phones get a replay for `all` and `sall`, and for each
  `group` box their group index and the latest value of their own group (and
  no other). Group membership is stable: a joiner goes into the group with the
  smallest `length / weight` (lowest index on a tie), a leaver is removed, and
  no one else moves. Only the shuffle inlet repartitions; after it every phone
  is sent its new index and its new group's latest value.
- **Groups.** `group N` is N equal groups;
  `group w0 w1 …` (two or more args) is one group per weight, sized in
  proportion. Bad args (no arg, a count that isn't a whole number ≥ 1, a
  weight that isn't a positive number) reject the apply. `groupArgs` in
  `public/gpi-types.js` is the one parse, shared by the editor, apply and the
  server. Outlet 1 is the phone's group index, 0-based, sent as `rv` on ch 1
  whenever its membership is set: at the build (every group box is now
  partitioned when the server graph builds, not on its first value), on join
  and after a shuffle, whether or not the group has a stored value. Build and
  shuffle deal the shuffled phones one by one to the smallest
  `length / weight` group.
- **D4 / D7.** The envelope flashes and ramp~ animation are drawn by the ctrl
  page. The server's 240 Hz tick stays as the evaluation clock, and the
  metro-phase display comes from the metro's state. The tick paradigm itself is
  still an open question.
- **Metro restart.** When metro inlet 0 goes from off (undefined, ≤0) to on
  (>0), the cycle restarts and it fires on the next tick. A new value while it
  is running doesn't reset it.
- **Engine message ports.** A cabled value reaches a message port only if the
  port's inlet is number-typed. The only one is `adsr~`'s gate (>0 opens, 0
  closes). Event-typed ports (triggers) are fired by events only.
- **Phone semantics win:** `phasor once` stays finished, `delay` fires once,
  `seq` inlet 1 takes a string.
- **Side rule (revised 2026-11-08).** No box but a router crosses the line;
  every other box lies wholly on one side, and a free box's side is where it
  lies. A bound box (ctrl/synth) must be on its own side; on commit it is
  moved snug against the line on that side. The rule lives only in
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

- **Open, encapsulate follow-ups:** a mouse gesture to trigger it (Thomas
  first liked a gesture, since it could pick ctrl or synth at creation), a
  better naming UI than the prompt, and de-encapsulate.
- **Worktrees to remove** once Thomas agrees: `~/Documents/tamb-grid`,
  `tamb-samples`, `tamb-abs`, `tamb-faces`, and their `feat/*` branches (all
  merged).
- **Still open from the 2026-10-30 list:**
  - merge to main;
  - per-voice ensemble viewport tiles (`network-and-modes.md`, Rung 0a);
  - ctrl.js MIDI auto-create side fix (see above);
  - the Bun swap;
  - group-scoped routers (`group 5 fold`, `all @fold:4`);
  - router vs cable mismatch for triggers (`processRouterValue` in
    `public/graph.js` writes a value into an event-typed trigger; a cable
    drops it);
  - patches saved from the editor are root-owned (server runs under sudo);
  - the `group` help text, for Thomas to rewrite.
- **Next big item:** the fresh-repo checklist in `notes/launch.md`.
- **Parked:** live granulation (`record~`), breath/bite/nod/tilt as
  abstractions, a presentation mode, laptop DNS decoupling, salvaged network
  hardware, and the 240 Hz tick paradigm.
