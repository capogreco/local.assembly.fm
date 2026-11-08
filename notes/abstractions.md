# Abstractions

Internal notes. A proposal from a Fable review (2026-11-08), with Thomas's
decisions marked. It replaces the "Abstraction workflow" item under "Parked"
in `editor-modes.md`, and the port typing in `libraries.md` §5.

## Facts from the code (2026-11-08)

- The editor knows nothing about an abstraction's ports: `getInletDef` and
  `getOutletDef` read only `BOX_TYPES`, so an abstraction gets no tooltips, no
  audio colour and no number→audio refusal. Mistakes surface only at apply,
  after expansion.
- A port mismatch at apply is a warning today: the cable is deleted and the
  deploy goes ahead (`apply-check.ts:108`). This is Pd's "connection failed".
- `sanitizeName` strips `~` and `/` (`server.ts:545`), so `grain-voice~` and
  `lib/name` can't be saved.
- An unfilled `$1` stays literal, so `buffer~ $1` with no argument would try
  to preload a file called `$1`.
- `breath`/`bite`/`nod`/`tilt` are found by exact text match
  (`server.ts:310`), so `breath 0.5` never receives CC.

## Decided (Thomas, 2026-11-08)

- **Explicit, opinionated, type-safe.** The side and port types are declared,
  then checked. They're not inferred.
- **Every abstraction picks a side: `ctrl` or `synth`.** No `free`
  abstractions; built-in boxes can still be free. `double` and `quantiser`
  must pick a side (or exist once per side).
- **Initial values come from `const`**, which already fires when the patch is
  built. No new box.
- **Abstractions get help and descriptions**, on a par with built-ins.
- **Namespaces.** `core` ships with Tambourin and is the only privileged
  library. `assembly` is a user library like anyone else's.
- **No `clone`:** one phone = one voice.

## Proposal

**Header.** The contract lives in file-level metadata in the abstraction's
JSON. The inner `inlet`/`outlet` boxes keep only their index.

```json
{
  "name": "thomas/grain-voice~",
  "side": "synth",
  "description": "One granular voice reading a named buffer~.",
  "args": [{ "name": "buffer", "type": "symbol", "description": "buffer~ name" }],
  "inlets":  [{ "name": "position", "type": "audio", "description": "0-1 of the buffer" }],
  "outlets": [{ "name": "out", "type": "audio", "description": "mono grain stream" }],
  "boxes": [], "cables": [], "nextId": 1
}
```

The types are the existing port types. The abstraction editor gets a small
panel for editing the header. Help patches sit beside the abstraction.

**Checks (all errors).**
- *Save:* the declared side against the contents; the header against the
  `inlet`/`outlet` boxes (no gaps, no extras); port types against the wiring
  inside; a `$n` with no declared argument.
- *Load:* a malformed header stops the server and names the file.
- *Apply:* port counts and types across the boundary, and missing
  arguments, with nesting checked recursively. One line per problem:
  `"<instance>" inlet <i> (<name>, <type>): <problem>`.

**Editing.**
- *Create:* Shift+N asks for a name, a side and a library.
- *Rename:* lists the patches that use the old name, without rewriting
  them.
- *Delete:* refused while the running patch uses the abstraction.
- *Run mode:* allows only `h`.
- *Encapsulate (decided 2026-11-08, built on feat/faces):* Cmd+Shift+E
  (Ctrl+Shift+E elsewhere; Max's shortcut), ctrl editor, edit mode. Asks
  for `library/name` (as Shift+N) and turns the selection into a new
  abstraction plus one instance of it. Refused, nothing changed: empty
  selection, a router, boxes from both zones, an empty or unfinished box, an
  `inlet`/`outlet` box, a name that's invalid or taken, anything the
  server's save check rejects (its errors shown). Side = the selection's
  zone. Ports = the cables crossing the selection's edge: one inlet per
  inside (box, inlet) fed from outside, one outlet per inside (box, outlet)
  feeding outside, ordered by the inside port's x, ties by box y (Pd). Name
  (made unique), type and description from the inside port; an inside
  number inlet fed audio from outside (an AudioParam) becomes an audio
  inlet, and one fed both audio and values is refused. Inside, the boxes keep
  their layout, moved near the origin, with `inlet i` boxes on a row above
  and `outlet i` boxes on a row below, each over its port. No args, no face,
  empty description: added in the abstraction editor. The registry reloads
  (and syncs ports) before the plan is made. Saved through PUT
  `/abstractions/<name>?create=1`, which answers 409 if the name is loaded
  or its file exists; only then the registry reloads and the instance
  replaces the selection at its top-left (kept wholly on its side), outside
  cables on its ports with their ids kept, then is nudged alone clear of
  its neighbours (`l`'s logic). One undo step; undo doesn't delete the
  saved file. A second press while one is saving is ignored. `PatchEditor.encapsulation`/`applyEncapsulation`,
  `tests/encapsulate.ts`.

**Port changes to existing instances.**
- *Open patch:* drop the cables that no longer fit and list each one in the
  editor.
- *Running patch:* nothing changes until the next apply. A save must never
  change a show in progress.

**Migration.** `double` and `quantiser` get headers and sides.
`breath`/`bite`/`nod`/`tilt` become abstractions in Thomas's library, built
on `cc`, with `> 0.01` → `change` for the gate. The hard-coded `lib: "maker"`
rows, `CC_SOURCE` and `findBoxByText` go.

**Order.** Each step can be tested on its own.
1. Header, loader and registry.
2. Save checks.
3. Apply checks.
4. The editor: tooltips, colours, refusals, the header panel.
5. Namespaces.
6. Port changes in the open patch.
7. The BBC2 migration, then `grain-voice~` once `buffer~`/`play~` exist, with
   media collected after expansion.

## Built (2026-11-08, feat/abstractions)

Steps 1, 2, 3 and 5, and the header panel from 4.
- **Header** in the file: `name`, `side`, `description`, `args`, `inlets`,
  `outlets`; unknown fields are refused. `parseAbstraction` in
  `apply-check.ts`. gpi-types' `useAbstractions` gives the editor ports,
  types and sides for instances; `boxBinding` returns the declared side.
- **Save, load and apply** run the same `checkAbstraction`. A bad library
  file stops the server and names the file. Apply also checks each instance's
  args and each cable on it, nested ones after their args are filled in.
- **Types across a boundary.** Audio must meet audio. One exception, as for
  built-ins: inside an abstraction, an audio inlet may feed a number inlet of
  a built-in audio box (an AudioParam), and an audio outlet may feed one
  outside. An abstraction's own number inlet is not an AudioParam.
- **Args.** Missing, too many, or a non-number for a `number` arg are errors.
- **Delete** is refused while the running patch, or another abstraction,
  uses it. Rename is not built.
- `double` is `ctrl`, `quantiser` is `synth` (its only use, in
  `patches/archive/sendup_test.json`, is synth-side), both in `libs/common`
  (a placeholder name).

Review fixes (feat/abstractions, merged into feat/faces 2026-11-08):
- One cable type rule, `cableTypeProblem` in gpi-types, for the editor and
  apply; audio never goes into a `message: true` inlet (adsr~ gate).
- Save also refuses an inlet wired straight to an outlet, a nested
  instance's missing ports, and unknown inner box types. `checkSave` checks
  the whole library before writing, and the server rolls back a write that
  fails to reload.
- A `$n` in the patch itself is an apply error; args go in as written
  (function replacer, so `$&` and the like stay literal).
- `PatchEditor.syncAbstractionPorts()`: ctrl loads the registry before it
  connects, then after every registry or state load instances take their
  header's ports, and cables to ports that are gone are dropped and listed.
  A faced instance whose new face no longer lies wholly on its side is
  listed too (not moved).
- `ABS_NAME` and `LIB_NAME` come from gpi-types.

## Decided (Thomas, 2026-11-08, second round)

- **Names are always explicit.** A library abstraction is always written
  `library/name`, in boxes and in saved patches. There's no short form and
  no search order. Names may be longer; it keeps things simple. (Built-in
  boxes keep their bare names.)
- **Abstractions are not core.** `core` is built-in boxes only. Every
  abstraction lives in a library, written `library/name`. Tambourin ships with
  a few ready-to-go libraries of common abstractions, in the same
  `libs/<lib>/` format as user libraries: bundled but not privileged.
  `double` and `quantiser` move there. Their names and contents are to come.
- **A face for each abstraction, like Pd's graph-on-parent.** Pd lets an
  abstraction's author set a rectangle inside it: on the parent, the instance
  becomes a box of that size showing the GUI objects inside the rectangle
  (sliders, toggles, number boxes, arrays). Object boxes, message boxes and
  cables stay hidden, and the name and arguments can be hidden too. Max does
  the same with `bpatcher`. For Tambourin, the header declares the face: a
  rectangle and the GUI boxes in it (knobs, number displays, scopes). The
  instance draws at that size, with ports on its edges. On the synth side the
  face shows in the editor only; what phones display is the separate visual
  paradigm question (see `identity.md`).
- **A port mismatch at apply is an error.** The running patch keeps running,
  and only the change is held back.
- **Libraries live in `libs/<lib>/`**: worklets, abstractions and help
  together, as in `libraries.md` §1, so all of a user's pieces are in one
  place.
- **Identity:** a namespace is a folder locally. It's tied to an account only
  when publishing to or fetching from tambourin.fm (later, with accounts).

## Open

- The bundled libraries: names (one general library, or themed ones such
  as `granular/` and `midi/`) and contents.

## Face proposal (Fable, 2026-11-08)

Sources: Max's `bpatcher` and presentation mode docs; Pd's
`tcl/dialog_canvas.tcl`, `src/g_canvas.c` (`gobj_shouldvis`) and
`src/g_graph.c` (`graph_vis`).

**Header.** `"face": { "x": 0, "y": 0, "w": 6, "h": 3, "hideName": false }`,
with the rectangle in grid units; boxes stay in px. The face shows every GUI
box lying wholly inside the rectangle, which is Pd's rule. Pd silently hides a
box that crosses the edge; we refuse it at save. `hideName` hides the name and
arguments together, as Pd's single checkbox does.

**What counts as GUI.** A `gui` flag on the box's row in `gpi-types.js`:
- `control`: knob, toggle, event, fan. This replaces the hard-coded
  `INTERACTIVE_TYPES` (`patch-editor.js:22`).
- `display`: print, and `scope~` (drawn only on phones; a placeholder in
  the editor).
- `label`: comment.

**Mapping a face's controls to the patch.** `expandAbstractions` already
builds each instance's local→global id map, then throws it away. Instead, keep
it and send it to ctrl with `applied` and with full state. A knob on a face
then sends the expanded box's id, and the server's knob path is unchanged.
Display values come through the existing `values` messages.

**Found along the way.**
- A reconnecting ctrl receives the *expanded* graph (`getFullState`,
  `server.ts:258`), so it loses its abstraction instances. The server should
  keep the patch as authored and send that, plus the map. (Fixed 2026-11-08:
  `applyPatch` keeps the authored patch and `ctrlState` in `patch-state.ts`
  sends it; the map is still to come with faces.)
- Knob and toggle values aren't saved, and every apply resets each knob to
  its text argument (`initSources`, `eval-engine.ts:566`). The proposed fix
  serves both levels: the patch stores the values (`state` on an instance
  box, `value` on a top-level knob), and the patch build prefers them.

**Drawing and interaction.**
- A faced instance is `w×20 × h×20`. Every place that assumes the fixed
  `BOX_HEIGHT` instead takes the box's own height, including the side rules.
- Faced instances snap to the grid dots.
- Ports go along the top and bottom edges, coloured by their header types.
- In edit mode the face behaves as one box (select, move, cable,
  double-click to open). In run mode its controls work.
- Nested faces are drawn recursively.

**Authoring.**
- In the abstraction editor, `f` drags out a rectangle snapped to the grid,
  drawn dashed at the 1px weight.
- Errors at save: a rectangle not in whole grid units; smaller than 2×2;
  no GUI box inside; a GUI box crossing the edge.

**Order.**
1. The `gui` flag.
2. `face` in the header, the loader and the save checks.
3. The instance map: the server keeps the authored patch, and ctrl stores
   the map.
4. Box height, drawing, ports, snapping, and edit mode.
5. Run mode on faces.
6. Saving values.
7. The face tool in the abstraction editor.
8. Nesting.

**Decided (Thomas, 2026-11-08).**
1. The face is in grid units. All boxes now sit on the grid too (see "Grid"
   in `editor-modes.md`).
2. The face shows every GUI box wholly inside the rectangle. A box crossing
   the edge is an error.
3. A face needs at least one GUI box; a comment counts as one.
4. **Strict: no values are saved, and every apply resets.** Thomas uses
   re-apply to hush a patch in performance. Initial values come explicitly
   from `const`, so `knob` (and any other box that holds a value) needs a
   "set" inlet, as `toggle` has. Drop "Saving values" from the order.
   (Built 2026-11-08: `knob` inlet 0 sets, clamps to min..max and outputs;
   the knob holds its value as graph state, so a `const` feeding it at build
   gives the starting value. `toggle` already had one; `event` and `fan`
   hold nothing the UI sets. Hardware sources (`arc`, `grid-toggle`) also
   reset on apply and have no set inlet yet.)
5. `hideName` hides the name and arguments together.
6. Grid snapping applies to every box, not only faced instances.

**Built (2026-11-08, feat/faces).** Steps 1–5, 7 and 8 above.
- `knob` is ctrl-bound (decided 2026-11-08): a synth-side knob fired its
  init at build on every phone. A synth abstraction can't hold one; a knob
  reaches phones through a router. `toggle`, `event`, `fan` stay free.
- `gui` on the BOX_TYPES rows: `control` knob, toggle, event, fan;
  `display` print, scope~ (drawn as a plain box); `label` comment and `//`.
  A faced abstraction counts as a GUI box of its parent (`guiKind` "face").
- Box geometry lives in `gpi-types.js` (`textBoxWidth`, `boxSize`,
  `boxHeight`, `faceContents`), so the server's save check and the editor
  agree on extents. Width counts characters at 7.2px (12px monospace)
  rather than measuring text.
- `face` in the header, optional; `hideName` is required inside it.
- Instance maps: `expandAbstractions` records each instance's local→global
  ids, nested ones under their own global id; ctrl gets them with `applied`
  and `state`. A map applies only while the instance's text is unchanged.
- The face tool: `f` in the abstraction editor, then drag; the header
  panel edits, hides the name, or clears it. Not on the undo stack.
- Example: `common/pitch-amp`, used by `patches/faces_pitch-amp.json`.

**Questions as put to Thomas (Fable's recommendation in brackets).**
1. Face in grid units while boxes stay in px? (Yes.)
2. Everything GUI inside the rectangle, or an explicit list? (Everything
   inside; an error when a box crosses the edge.)
3. A face with no GUI box, a pure label? (Refuse, but a comment counts.)
4. Save knob and toggle values in the patch, at the top level too, which
   changes today's reset-on-apply? (Yes, both.)
5. `hideName` hides the arguments too? (Yes, one flag, as Pd.)
6. Snap only faced instances to the grid, or everything? (Faced instances
   now; everything later, as identity work.)
