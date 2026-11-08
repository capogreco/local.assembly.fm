# Samples and granular synthesis

Internal notes. The core set should have enough to build a granular synthesis
abstraction. Recommendation from a Fable review (2026-11-08); Thomas's
decisions are marked.

## Approach

A worklet reader driven by `phasor~`, not one native `AudioBufferSourceNode`
per grain. Events reach phones without timestamps at the next render quantum,
with network jitter, so grain onsets can't come from the server. The server
sets the cloud's parameters (position, size, rate); the grain clock runs in the
audio thread. This is Pd's standard granular patch, and every part of it can be
patched. Native nodes would hide a main-thread scheduler inside one `grain~`
box, and a pause on a weak phone would drop grains.

Getting audio into the worklet: decode on the main thread, then transfer the
channel data to the worklet once (`postMessage` with a transfer list, so no
copy). All processors share one AudioWorkletGlobalScope, so a module-level map
of name → samples lets every `play~` and `record~` share one copy. No
SharedArrayBuffer and no COOP/COEP headers.

## Decided (Thomas, 2026-11-08)

- **Position is 0–1** of the buffer, matching `phasor~`.
- **Media lives in `public/media/`**, like `impulse_responses/`. The deploy
  lists the files a patch needs; phones preload them, and ctrl shows
  "N of M loaded" before going live. Collect the media names after
  abstraction expansion, once `$1` is filled in.
- **Synth-side synthesis is mono only.** This is paradigmatic. Ctrl-side can
  pan and use multiple channels.
- **One phone = one voice.** No `clone`. A grain voice holds two grain
  streams half a cycle apart, so its window doesn't sound as a tremolo; the
  cloud forms in the room, from the phones overlapping.

## Proposed boxes

- `buffer~ name [file | seconds]`: a named mono buffer, loaded from
  `/media/` or silent for recording. Outlet: length in seconds, once loaded.
- `play~ name`: reads at a 0–1 position signal, 4-point interpolation, wraps.
- `record~ name [once]`: writes while the gate is open; ring by default.
- `hann~`: a phase shaper, 0–1 in, 0–1–0 hump out. (`cosine~` is a triggered
  envelope, not a shaper.)
- `samphold~`: samples its left inlet when the right decreases (a phasor
  wrap), as in Pd.
- `phasor~`: expose the existing `reset` message as an event inlet, and add a
  starting-phase argument. `phasor~ … once` into `play~` is then also the
  one-shot sampler.

## Built (2026-11-08, feat/samples)

`buffer~` (file or seconds), `play~`, `hann~`, `samphold~`, and `phasor~`'s
reset inlet (appended after period) and starting phase (`phasor~ period
[phase] [once]`; reset returns to it). Not `record~`.

- All are free (ordinary worklets). Buffer names are per side: each side's
  AudioContext has its own map. Apply rejects a name defined twice on one
  side, a `play~` with no `buffer~` of its name on its side, and a file that
  is not in `public/media/`.
- The deploy carries `buffers: [{ id, name, file | seconds }]` when there are
  any. Phones load them inside `loadPatchForVoice` (messages queue meanwhile),
  then each `buffer~` outlet emits its length. Ctrl shows "N of M loaded"
  under the client count. The laptop loads ctrl-side buffers and sends each
  length back as `buffer-length`.
- A re-deploy fetches only buffers whose name or file changed; a file edited
  on disk under the same name is not refetched until the name or file changes
  or the page reloads.
- `samphold~` also samples on its first frame (Pd starts at 0), so a stream
  that starts mid-cycle has a position at once.
- Test sample: `public/media/test-phrase.wav` from `deno task media`.
  Example: `patches/granular_example.json`.

## Open

- Live granulation (`record~`): from ctrl (the recording must then be sent
  to phones mid-show) or from each phone's microphone (iOS lowers output
  volume and may change the sample rate). Not needed for the first version.
- Depends on the abstraction workflow (typed ports, declared side,
  namespaces, help): see `editor-modes.md`, under "Parked".
