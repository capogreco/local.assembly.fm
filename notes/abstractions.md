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

## Decided (Thomas, 2026-11-08, second round)

- **Names are always explicit.** A library abstraction is always written
  `library/name`, in boxes and in saved patches. There's no short form and
  no search order. Names may be longer; it keeps things simple. (Built-in
  boxes keep their bare names.)
- **A GUI workflow for abstractions, as in Pd,** rather than typing names.
  To be designed.
- **A port mismatch at apply is an error.** The running patch keeps running,
  and only the change is held back.
- **Libraries live in `libs/<lib>/`**: worklets, abstractions and help
  together, as in `libraries.md` §1, so all of a user's pieces are in one
  place.
- **Identity:** a namespace is a folder locally. It's tied to an account only
  when publishing to or fetching from tambourin.fm (later, with accounts).

## Open

- The GUI workflow: creating, opening, saving and placing abstractions from
  the editor, modelled on Pd.
- Whether `core` abstractions are written `core/name` too. This follows from
  explicit naming.
