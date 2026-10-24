# Tambourine

> SKELETON. Headings and reminders only, to be written by hand. Delete this line when done.
> Facts to draw on live in `README.OLD-DELETE.md`, `notes/network-and-modes.md` and `notes/libraries.md`.

## What it is
- One or two sentences. Struck centre, vibration out to the rim, the jangles sound (laptop at the centre, phones at the rim).
- The dance (medieval *tambourin*), if it earns a line.
- Lineage: Pure Data first, SuperCollider, TouchDesigner.
- Status stance: early, breaks loudly, no stability promise. Reconcile with "not a framework".

## Quickstart (practice mode)
- Prerequisites and the single command. (Currently `deno task practice`; will change with Bun. Old README said `deno task dev`, which does not exist.)
- Which pages open (synth, ctrl, ensemble) and what you see: a blank canvas, a "press h for help" hint.
- How to hear something alone: ensemble page = N voices in one tab.
- Where the help patches live and how to open them.
- DECIDE: load/apply keys (`o`, `Cmd+Enter`) if they survive.
- NOTHING SHIPS PRE-BUILT: no performance patches, no sample patch. Help patches are the on-ramp.

## The idea
- The synth border: above runs once (laptop), below runs on every phone.
- Routers carry events and instant values across, never continuous streams.
- Two-phase propagation: cable order does not matter.
- Zones: ctrl, synth, router.

## Modes (a syllabus)
- practice: localhost, plain HTTP, no cert, no network hardware.
- workshop: LAN, self-signed cert, tap through one warning, join by QR.
- performance: real domain + trusted cert + captive portal. Say plainly it needs a domain you own and DNS-01; renewal needs an uplink, so renew before load-in.
- One line on why the cert chain exists: AudioWorklet needs a secure context.
- Failures should explain themselves ("insecure origin, open via https").

## Objects and libraries
- Core set vs library (see `notes/libraries.md`).
- How a library directory drops in (once built).
- Keyboard-to-MIDI is an object, optional, not default.

## Hardware (all optional)
- Monome Grid/Arc, MIDI, BBC2.
- Reference rig: laptop, router/APs, switch. The instrument does not depend on it.
- Parameterise before documenting: hostname, SSID, `192.168.178.x` subnet.

## Housekeeping
- Licence: GPLv3.
- Where to talk (lines), how to contribute.
- Credit: made by assembly (artist). Third-party notices (Pink Trombone etc.) if shipped.
- Local vs cloud: at most one paragraph, late; cloud is later and has different priorities.
