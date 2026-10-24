# Libraries: design sketch

Status: sketch, nothing built. Release 1 = core + one library (the maker's), dropped in as a directory. No package manager, namespacing, versioning or ctrl-side plugin API. Libraries hold synth-side AudioWorklet engines plus abstraction patches. Ctrl-side evaluation (`graph-core.js`, `eval-engine.ts`) stays hard-coded.

## 1. Layout

```
libs/<lib>/
  lib.json                 box rows + engine blocks
  worklets/*.js            AudioWorkletProcessor modules
  abstractions/*.json      same format as abstractions/
  help/*.json              help patches, normal patch format
help/                      core help patches (moved out of abstractions/)
abstractions/              user abstractions (unchanged)
```

## 2. lib.json

Each entry in `types` is a BOX_TYPES row (`zone`, `description`, `args`, `example`, `inlets`, `outlets`) plus an `engine` block. The existing `args` string stays descriptive. The parsed list goes in `engine.args`.

Worked example. It is derived from the `ewing~` row in gpi-types.js, the `ENGINES` row, the frog~/ewing~ branch at engine-factory.js:254-259, and `ewing-processor.js` (params `pitch`/`hold`/`active`, reads `processorOptions.glideSec ?? 1.0`):

```json
{
  "name": "maker",
  "types": {
    "ewing~": {
      "zone": "synth",
      "description": "Ewing's Tree Frog (Litoria ewingii). Autonomous frog ...",
      "args": "[glide_sec]",
      "example": "ewing~ 1.0",
      "inlets": [
        { "name": "pitch",  "type": "number", "description": "Held-tone fundamental in Hz (used when hold > 0)" },
        { "name": "hold",   "type": "number", "description": "0-1: 0=autonomous chatter, 1=sustained tone" },
        { "name": "active", "type": "number", "description": "On/off gate, wind up/down over glideSec x 6" }
      ],
      "outlets": [{ "name": "out", "type": "audio", "description": "Audio output" }],
      "engine": {
        "module": "worklets/ewing-processor.js",
        "processor": "ewing-processor",
        "args": [{ "name": "glideSec", "kind": "number", "default": 1.0, "to": "option" }]
      }
    }
  }
}
```

Positional `engine.args` (`kind: number|string`) take tokens in order. `flag`/`enum` entries match a token anywhere. `to` is `option` (processorOptions), `param` (`setValueAtTime` on that AudioParam) or `message` (`port.postMessage({[name]: value})`). The output channel count is the number of `audio` outlets.

| Today | Data form |
|---|---|
| `ENGINES`, `SIGNAL_WORKLETS` rows | `engine.module`, `engine.processor` |
| formant~ `channels: 4`; chaos~ `outputChannelCount: [3]` + splitter | N audio outlets -> `[N]` + splitter, `outputs[i]` = channel i |
| frog~/ewing~ `glideSec`, per-type default | `to: "option"` arg with `default` |
| chaos~ `system` | string arg, `to: "option"` |
| lfo~ ... slew~ positional `setValueAtTime` | `to: "param"` args |
| lfo~ `bipolar`; sigmoid~/cosine~ `interrupt`/`respect` | `flag`/`enum`, `to: "message"` |
| `trigger`/`gate` by name (main.js:204-206, ctrl.js:238-241) | `event` inlet -> `postMessage({type})`; `"port": true` inlet -> `{type, value}` |

These cannot be data and stay core code: lfo~ `random` (a per-instance `Math.random()`), everything in `createNativeNode` (native nodes, sig~ portamento, noise~ picking a worklet by arg, conv~ fetching an IR), `MATH_OPS` (op taken from the type name), and `scopeHandler`/`adcHandler`/fftPeaks~ (they need DOM, analysers or media input). None of these are worklet engines.

## 3. Server flow

1. After `importCjs` of gpi-types.js (server.ts:110), `loadLibraries()` reads `libs/*/lib.json`, validates it (section 6), rewrites `engine.module` to `/libs/maker/worklets/...`, and calls a new `registerTypes(rows)` from gpi-types.js. `registerTypes` mutates the single `BOX_TYPES` object, so `getBoxDef`, `isAudioBox` and eval-engine see the merged table unchanged.
2. `loadAbstractions()` (server.ts ~878) also walks `libs/*/abstractions`.
3. Add routes in `appHandler` (~859): static `GET /libs/...` (`serveFile` only reads `./public`), `GET /types` (library rows as JSON), and `GET /help/<type>`.
4. In `serializeSynthPatch` (~517-521), audio boxes already get `pb.engine = true` and `paramNames`. Add `pb.engineDef` and `pb.portNames`. The new name avoids `engine`, which is already a boolean that `graph.js:64` reads.
5. On the phone, `buildGraph` (graph.js:64) carries `engineDef` into `graph.engines`, and `loadPatchForVoice` (main.js:269) passes it to `createEngine`, which calls `addModule` once per module via `workletModulesLoaded`. Phones never load the type table.
6. The editor (ctrl.js imports gpi-types.js as ESM) fetches `/types` next to `loadAbstractions()` and calls `registerTypes` before the first patch load. Server and editor run the same merge code on the same rows.

## 4. Change list

1. **gpi-types.js**: `registerTypes` (ESM + CJS export), plus `engine` blocks on the core worklet rows. ~60 lines, low risk. Safe before Bun.
2. **engine-factory.js**: replace the two tables and the per-type branches with one data-driven `createWorkletEngine`. Keep `createNativeNode` and `createMathNode`. About -120/+70 lines, medium risk: every envelope and engine passes through it, so test each one. Safe before Bun.
3. **main.js, ctrl.js**: pass `engineDef` through and use `portNames` in place of the trigger/gate checks. ~20 lines, medium risk (adsr~ gate, ks/frog triggers). Safe before Bun.
4. **patch-editor.js**: port typing (section 5). ~40 lines, low risk. Safe before Bun.
5. **server.ts**: `loadLibraries`, the three routes, `engineDef`, unknown-type errors. ~120 lines, medium risk. It uses `Deno.readDir`/`readFile`, so **wait for Bun** or go through a small fs helper.

Steps 1-4 work without any `libs/` directory.

## 5. Abstraction port typing

`loadAbstractions` (patch-editor.js) gives abstractions `inlets: [], outlets: []`. Proposal: `inlet 0 freq number` / `outlet 0 out audio`, where the optional name and type follow the index. `loadAbstractions` builds `def.inlets[idx]` from them (the type defaults to `passthrough`), and the first `comment` box becomes the description. `expandAbstractions` (server.ts:251) reads only the index, so it needs no change. Audio ports through abstractions are not handled by expansion today. That is a separate job.

## 6. Failure behaviour

- **Duplicate name** (library vs core, library vs abstraction): the server refuses to start and names both sources.
- **Missing worklet file or malformed lib.json**: the server refuses to start and names the file.
- **Library engine with zone other than `synth`**: refused (see open question 1).
- **Patch uses a type that isn't installed**: today `serializeSynthPatch` silently skips it (`if (!def) continue;`), and the editor only marks it unknown (patch-editor.js:907). Change: apply reports "unknown box type: X" through the existing `{type: "errors"}` message (server.ts ~403) and does not deploy.
- **Worklet fails on a phone** (`addModule` rejects, or an inlet has no matching AudioParam): today it is a console log only (main.js ~271). Add a phone-to-server `engine-error` message that is forwarded to ctrl `errors`.

## 7. Trust and safety

Library worklets run arbitrary JS on audience phones. The worklet scope has no DOM or `fetch`, but the code can still burn CPU or emit NaN, DC or full-scale noise. Installing a library means trusting it like any program. The server serves only local directories. Protection belongs in core. On phones, dac~ is not a node: it wires to `voice.destination` -> panner -> `masterGain` (main.js ~384, ~662). Put a DC blocker (about 10 Hz high-pass) and then a hard limiter between `masterGain` and `audioCtx.destination`. Make the limiter a core worklet that also zeroes NaN/Inf, because `DynamicsCompressorNode` is not a brickwall limiter. ctrl.js's output needs the same stage.

## 8. Open questions (ranked)

1. **Synth-only contradicts current zones.** karplus-strong~, reverb~, swarm~, formant~ and chaos~ are `zone: "any"`, and ctrl.js builds them on the laptop through the shared engine-factory.js. Making them synth-only drops laptop use. Letting ctrl.js also fetch `/types` costs almost nothing. Allow `zone: "any"`?
2. **conv~ is not a worklet.** It is a native `ConvolverNode` plus an IR fetch, so it can't be library material under "worklets + abstractions". Keep it in core?
3. **Help lookup is broken.** `openHelp` (ctrl.js:371) fetches `/abstractions/<type>-help`, but `sanitizeName` strips `~` (so `ewing~` resolves to `ewing-help`), and `/~` can't be a filename at all. Help patches in `abstractions/` also show up as instantiable abstractions. Proposal: each help patch carries `"helpFor": "ewing~"`, and the server indexes the help directories by that field (a duplicate is a load error). Also, `phasor-help.json` is stale: it documents 2 inlets and a frequency, but `phasor` has `reset`, `period`, `pause`.
4. Do core worklets move to engine blocks in release 1 (one code path), or only library engines?
5. What does `h` open with nothing selected? Today it needs exactly one selected box (ctrl.js:537). `help/index.json`?
6. Should a patch record the libraries it needs? That is close to namespacing, so not for release 1.

## 9. Findings while attempting the `trigger`/`gate` cleanup

Deferred, not done. The name-based convention is wider than the two obvious sites:

- Synth side: `main.js:204-206` and `ctrl.js:238-241` post `{type:"trigger"}` / `{type:"gate", value}` by inlet *name*.
- Ctrl side: `graph-core.js:725`, `:834` and `:925` also test `paramName === "trigger" || "gate"` to decide propagation semantics. This is the same wall as the ctrl-side behaviour switches in section 3.
- `main.js` has no access to box definitions (it does not import `gpi-types.js`), so a data-driven check there needs the deploy message to carry a per-inlet "message" flag.
- (Stale note removed: `swarm~` has no `fire`/`match`/`event` inlets; all ten are `number`.)

Done: the deploy message carries `messagePorts` per engine box (inlets typed `event`, plus any flagged `message: true`; today only `adsr~`'s `gate`). `graph-core.js`, `main.js` and `ctrl.js` read that instead of testing for `trigger`/`gate`. Check by ear: `adsr~` gate, karplus-strong, `frog~`, `ar~` and `step~` triggers.
