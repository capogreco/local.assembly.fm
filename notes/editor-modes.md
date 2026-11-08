# Editor modes: edit and run

Decided 2026-11-05. This replaces the modeless editor from 2026-03-19
(`dev_log.md:809`). That editor triggered interactive boxes on click-without-drag
so a performer could edit mid-show without switching modes. Its costs:

- drag always moves a box, so there is no drag-to-set, and the knob had to use
  the scroll wheel, which is poor on a trackpad and impossible on touch;
- the 1px line between click and drag is brittle with real hands;
- it breaks with the Pd lineage.

## Names

- **Editor modes: `edit` and `run`**, Pd's own terms. ("Locked" is Max's.)
- **Network modes: `practice`, `workshop`, `performance`.** These used to be
  called "run modes"; the category was renamed to avoid the clash with `run`.

## Behaviour

- **edit:**
  - click selects, drag moves, double-click edits text, and cables can be made;
  - interactive boxes don't respond;
  - **the dot grid shows**.
- **run:**
  - clicks and drags go to the boxes: drag-to-set on knobs and numbers,
    clicking toggles and events, with room later for drawing or touch gestures;
  - nothing moves or gets selected;
  - the grid is hidden.
- **Switching:** Cmd+E (Ctrl+E on other platforms). Holding Cmd in edit mode
  uses a box as if in run mode, as in Pd. Editing mid-show stays one keystroke
  away.
- **Scope:** the mode is local to each ctrl tab, never sent to the server, and
  doesn't affect phones.
- **Opening:** the editor opens in edit mode. This is a chance for continuity
  with the dot grid in a welcome animation (identity work, not designed yet).
  For now, saved patches open in edit mode too (Pd opens them in run).

## Grid (decided 2026-11-08)

The editor's 20px grid is binding, not decoration. It keeps patches neat and
gives them Pd's look.

- **Each box's top-left corner sits on a grid dot, or halfway between dots
  on either axis** (`SNAP`, 10px; decided 2026-11-08, so routers can sit
  on both sides of the membrane). Creating, dragging, pasting, neatening and
  arrow-key nudges all move in half units. Old patches snap when they load.
  Sizes stay whole units (heights, widths, faces) and the dots are still
  drawn every 20px.
- **Boxes are one unit (20px) tall**, replacing `BOX_HEIGHT` 22. A box's
  bottom edge, where its outlets sit, lies on the next row of dots.
- **Widths round up to whole units**, so the right edge is on the grid too.
- **Ports as in Pd:** inlet 0 and outlet 0 sit flush with the left edge, the
  last port flush with the right edge, and any others spread evenly between.
  They are drawn inside the box (inlets inside the top edge, outlets inside
  the bottom), so nothing of a box protrudes and it can sit snug against the
  line. A box placed directly under another gets a vertical cable from left
  outlet to left inlet.
- **The border sits on a row of dots** (whole units; border drags move in
  whole rows).
- **Routers straddle the border**, their vertical centre on the line, half
  on each side: `routerY(borderY) = borderY - BOX_HEIGHT / 2` in
  `gpi-types.js`, used by the editor and by apply. Routers are bound
  `border`, so their position never decides their side.
- **No box but a router crosses the line** (decided 2026-11-08). Every
  other box, free ones, faced instances (at their face height) and comments
  included, lies wholly on one side: bottom on the line is wholly ctrl, top
  on the line wholly synth. A bound box must lie on its own side; a free
  box on either, and that side is its side.
- **A box's zone comes from its type once its text is committed**
  (`placeOnSide`): a router goes on the border row; a bound box that
  straddles or lies on the other side goes snug against the line on its own
  side (top on the line for synth, bottom on it for ctrl). A free box has no
  zone from its type and stays where it is.
- **Free boxes never straddle**, because nothing in the editor makes one:
  a new box goes wholly on the side of the pointer (a click within half a
  unit above the line makes a box snug above it); Tab keeps the source's
  side (from a ctrl box too near the line, the new box goes snug on the
  line, or to the source's right); paste steps less than a unit down when a
  ctrl box would cross; a drag or nudge that would leave a box straddling is
  cancelled, as one that takes a bound box off side is. Moved wholly across,
  a free box takes the other side. A box already off side (an old patch)
  moves freely until it is back; a free one there goes, on commit or paste,
  snug to the side holding more of it. Apply still refuses any box but a
  router crossing the line, naming it: a backstop for patches that didn't
  come through the editor.
- **Abstraction faces** are whole units by construction (`abstractions.md`).
- **`l` neatens in place** (decided 2026-11-08, replacing the Sugiyama
  auto-layout, which threw the arrangement away). As Pd's Tidy Up: the
  selection, or the whole patch if nothing is selected, in the ctrl
  editor's edit mode, one undo step. Positions snap to half units (a no-op on any loaded patch, which
  load already snapped); a box fed
  from above straightens under its source, top-down so chains straighten:
  outlet 0 to inlet 0 with left edges within two units takes the source's
  left edge (the nearest source wins); failing that, another port pair
  within a unit lines up when it can on half units (in practice right outlet
  over right inlet). Only x moves, so no box changes side and routers stay
  on the border row. A move that would land a box on another is skipped, not
  pushed. Repeated to a standstill, so a second press changes nothing. Boxes
  sharing a row are left as they are.

Built 2026-11-08 (`feat/grid`, half units on `feat/faces`): `GRID`, `SNAP`,
`BOX_HEIGHT = GRID`, `snapToGrid` (whole units: the border), `snapPos` (half
units: positions) and `routerY` live in `gpi-types.js`. The editor snaps on
load (x, y and `borderY`), live while dragging, on create (the cell under the pointer),
paste, duplicate, Tab-create (one empty row below, kept on the source's side), neaten (`l`, below), and border drags
(the border moves in whole rows, at least two rows down, and pushed boxes
land snug against the line; each step is worked out from the drag's start,
so pushed boxes spring back as the border retreats, never past where they
began). Arrow keys nudge half a unit per press, a
whole unit with Shift; routers nudge sideways only.
Apply doesn't refuse off-grid positions: the grid is the editor's job, and
the side rules (`positionSide`, `wholeSide`) still work for any position.

## Parked

- A Max-style presentation mode: a second layout of the same patch, for
  playing. Separate question; revisit once edit and run exist.
- **The abstraction workflow** (flagged by Thomas, 2026-11-06; proposal and
  decisions now in `abstractions.md`): needs rethinking
  as a whole: creating, editing, saving, and how a saved abstraction's port
  changes reach boxes already in a running patch. For now, run mode blocks
  Shift+N (new abstraction). The abstraction editor and the help popup always
  stay in edit mode.
- **breath / bite / nod / tilt as abstractions** (Thomas, 2026-11-06). They
  are BBC2 MIDI CC inputs (CC 2, 1, 12, 13, with a threshold gate on breath
  and bite), hard-coded as `lib: "maker"` box types. The core `cc` object
  already exists, so they should become abstractions built on it, in the
  assembly library. Do this as part of the abstraction workflow; it may need
  abstraction arguments (for `[init]`).
