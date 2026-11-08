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
