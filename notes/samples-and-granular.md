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
- `samphold~`: samples its right inlet when the left decreases (a phasor
  wrap), as in Pd.
- `phasor~`: expose the existing `reset` message as an event inlet, and add a
  starting-phase argument. `phasor~ … once` into `play~` is then also the
  one-shot sampler.

## Open

- Live granulation (`record~`): from ctrl (the recording must then be sent
  to phones mid-show) or from each phone's microphone (iOS lowers output
  volume and may change the sample rate). Not needed for the first version.
- Depends on the abstraction workflow (typed ports, declared side,
  namespaces, help): see `editor-modes.md`, under "Parked".
