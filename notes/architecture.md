# Architecture: topology and seams

Status: server-as-evaluator signed off by Thomas 2026-10-24, from the topology review (one Fable pass, two rounds). Sync design still open. Internal note, not public prose. File:line references are to the repo at 30a2dce plus the behaviour-interface and dead-code changes made the same day.

Names: **Tambourine** is the platform (server, engines, network, tooling). **GPI** is the patch language (boxes, cables, rates, the border rule).

## Shape today

```
 ctrl tab                         server (one Deno process)                 phone tabs
 ────────                         ─────────────────────────                 ──────────
 patch editor                     patch-state globals                       graph-core + graph.js:
 laptop audio (engine-factory)    eval-engine.ts: evaluates every           evaluate the many-side
 MIDI, fftPeaks~ scan               one-side box, 240 Hz tick               graph per voice
                                  routerDispatch → rv/re                    engine-factory + main.js
   ──apply / knob / midi──▶       abstraction expansion, validation         worklets
   ◀──state / values (30 fps)──   ──patch, rv, re──────────────────────▶
                                  ◀──up (uplink)──────────────────────────
```

Problems found:
- Two evaluators for one box vocabulary: `eval-engine.ts` re-implements dispatch around `graph-core.js` rather than calling the same `buildGraph`/`propagateValue` a phone uses, and the behaviours have drifted.
- The ctrl tab is effectively a third synth client on its own protocol (`ctrl-audio-param`), not `rv/re`.
- `zone: "any"` covers 119 of 146 types; side is resolved by a y-test repeated at six sites.
- Server sends of `rv/re` are not funnelled: `routerDispatch` plus direct `_sendToClient`/`_broadcastSynth` calls (eval-engine.ts around :151, :153, :229, :658).

## Target shape (accepted)

```
 ctrl tab                      server (Bun)                              phones
 ────────                      ────────────                              ──────
 editor                        ONE graph evaluator (graph.js made        graph-core + engine-factory
 laptop audio (thin client,      runtime-neutral) for the one-side       (unchanged role)
   same rv/re + deploy as a    ONE clock source (metros, ticks)
   phone)                      expand abstractions, validate,
 MIDI / grid input             build TWO deploys: laptop, phones
                               router dispatch via ONE emit()
                               static files, /libs, /help
                               Monome OSC bridge (core)
```

- **Server is the single one-side evaluator and the only clock.** The ctrl tab is not the show's brain, so a throttled or overloaded tab cannot hurt timing. Cloud mode needs no laptop.
- **One deploy shape** for laptop and phones; `buildCtrlAudioTopology` and `buildAudioTopology` merge.
- **Side is position**, except hardware-bound boxes, which carry a constraint (`one` for MIDI/grid/arc/adc~/fftPeaks~/uplink/clients, `many` for screen/text/touch/scope~/sendup). `zone: "any"` goes.
- **Metros and clock-driven boxes are one-side only.** Free-running `lfo`/`phasor` below the border become the audio-thread `lfo~`/`phasor~` worklets (principles §4 already wants this).
- The phones keep evaluating their many-side graph. That is the border rule, not duplication.

Sequence to Bun:
1. Behaviour-interface (done), dead-code deletion (done), `emit()` consolidation (done, eval-engine.ts).
2. Hostname `local.tamb.fm` and SSID `tambourine` strings (done in code defaults and notes; cert and DNS are Thomas's).
3. Core/library sorting (done as `lib: "maker"` tags in gpi-types.js; see notes/core-and-library.md).
4. Remove SSE (done 2026-10-26: server handler and `sseClients` deleted, `public/connection.js` is WebSocket-only).
5. Then the port: one evaluator (graph.js made runtime-neutral), `zone: "any"` retired, one deploy shape, Bun, in the fresh repo. Not yet verified: that Bun can import the ESM files directly so the CJS shim disappears (inferred).

## Seams to build now (nothing else)

Sync is a design in its own right (below). Until it is designed, build only the places it would plug in. All three are no-ops today.

1. **Optional `t` on `rv` and `re`.** Server time at which a phone should apply the message. Absent means apply on arrival, as now.
2. **One `emit(msg, to?)` on the server** through which every `rv/re` leaves (done; the `PROFILE_ONSET` log hooks in there too). The only place a `t` could be stamped.
3. **One `applyAt(t, fn)` on the phone** called from `main.js` where `rv` and `re` are handled. Today it runs `fn()`. A small clock module behind it exposes `serverNow()` (stub).

Sync lives only in dedicated router objects (below). The plain routers (`all`, `one`, `group`, ...) never stamp a `t` and behave exactly as today, so there is no global lookahead setting. If settings are ever needed for other things: environment variables only give deployment defaults at server start (a hosted user cannot set them), and performer-facing settings would be changed from the ctrl UI over the WebSocket and kept in a server-side store. Not built.

## Sync: sync-* routers (decided 2026-10-24, not built)

The tool is agnostic about what the timing is used for. Sync is opt-in per router: the plain routers stay immediate and behave as today, and local mode already has very good latency, so most patches never touch it. The cloud-register idea (`concepts/sounding.md`: no compensation) is one more reason it is opt-in, never ambient.

Decided:
- **Sync lives only in router objects**, as a twin set: `sync-all`, `sync-one`, `sync-group`, `sync-sweep`, `sync-assign`, `sync-sall`, one per plain router.
- **Args on the sync routers**: lookahead, and `reject-late` (default `false`: a late message is applied on arrival; `true` drops it). `emit()` stamps the optional `t` only for messages from a sync-* router. `t` is on the monotonic server clock, in seconds (`performance.now() / 1000`).
- **Phones have a `sync-enabled` state**; sync-* routers skip phones that are not enabled.
- **Mechanism: a hand-rolled NTP-style estimator.** `@ircam/sync` was considered and dropped: its extra parts (clock-frequency regression, slow slewing, four statuses on two timescales) are not needed. No drift regression: phone clock skew is tens of ppm (inferred), under 1 ms over 15 s, and re-estimating every 2 s makes drift correction moot.
- **Output latency is treated as negligible**, and Bluetooth audio devices are not supported or compensated for. Nothing about output latency is measured or reported.
- Transport is WebSocket only (SSE is removed, below), so the estimator can assume a two-way channel.

### The estimator

Messages (infrastructural, never through rv/re/up):
- phone→server `{type:"sync-ping", id, t1}`; server replies at once `{type:"sync-pong", id, t1, t2, t3}` where t2 is receive time and t3 is send time, both server `performance.now()/1000`.
- server→phone on deploy `{type:"sync", on:true|false}`; the loop runs only while a sync-* router is deployed.
- phone→server about every 10 s, or on change: `{type:"sync-status", enabled, offset, errBound, jitter}`; the server relays it to the synth list.

Phone side (sketch, `local() = performance.now()/1000`):

```
RING = 8                       // RFC 5905 register size
start():   ping at 0, 0.25, ... 1.75 s  (8-ping burst, first offset in ~2 s)
           then ping every 2 s
ping():    id++; send {type:"sync-ping", id, t1: local()}
onPong(m): t4 = local()
           theta = ((m.t2 - m.t1) + (m.t3 - t4)) / 2     // server - phone
           delta = (t4 - m.t1) - (m.t3 - m.t2)           // round trip minus server hold
           keep the last RING samples {theta, delta}
           best   = the sample with the smallest delta   // least affected by a delayed packet
           offset = best.theta
           errBound = best.delta / 2                      // worst-case path asymmetry
           jitter = rms(theta_i - offset)
           enabled = (pongs >= 4)                         // value to tune
onTimeout (no pong for 3 s): enabled = false

serverToLocal(t) = t - offset
applyAt(t, fn):  wait = serverToLocal(t) - local()
                 if wait < 0: if rejectLate drop, else fn() now
                 else setTimeout(fn, wait * 1000)         // block granularity is fine
```

Triggers and gates need no sample accuracy, so a timer is enough. AudioParam changes can use `setValueAtTime` at `ctx.currentTime + (serverToLocal(t) - local())` (read the two clocks back to back; error is about one render quantum; do not use `getOutputTimestamp`, which is unreliable on Safari). Server side is about 5 lines: answer a ping with t2 and t3.

`errBound` is the honest limit of what any algorithm can know about a path with asymmetric delay. Choosing the smallest-delta sample makes wifi jitter mostly harmless. The offset is applied directly on each new sample, with no smoothing in v1.

### Still open
1. Lookahead arg default and range.
2. Ping cadence (2 s) and the `enabled` threshold (4 pongs): tune on real phones.
3. Whether a phone that times out re-enters sync routers automatically once pongs resume (leaning yes).
4. Verify on the actual iOS and Android phones in use that `performance.now()` and `setTimeout` behave while the screen is on and the tab is foreground.

### Performer view of connected phones (decided 2026-10-24)

Today the ctrl UI shows only a count ("N clients", drawn beside the synth border, `ctrl.js:363`), fed by a `count` message. There is no list.

- **A synth list drawn in the background** of the ctrl canvas, behind the patch: small font, low contrast so the patch stays readable in front. Columns: id, browser, audio state (running/suspended), patch loaded, sync-enabled, `errBound`, `jitter`.
- **Visibility is a global setting** (see "Global settings" below), not an environment variable.
- **Separate from uplink.** Uplink is compositional (values a patch sends back on named channels, handled by `sendup`/`uplink` boxes). This is infrastructural: a dedicated phone→server status message type that never reaches the patch graph, carrying browser, audio state, patch loaded and the sync status, which the server relays to ctrl.

Not built.

## Global settings (decided 2026-10-24)

Some settings do not travel with a patch (synth list visibility, and whatever else is a property of the venue or session rather than the patch). One paradigm for local and hosted mode: the server holds a `settings` object, the ctrl UI edits it over the WebSocket, and the server persists it (a file locally, a per-session record when hosted) and pushes changes to ctrl. Environment variables stay for deployment only (ports, domain, cert paths) and for the initial defaults of a settings key. UI form not designed yet.

## SSE is removed (decided 2026-10-24)

Synthesis inside the iOS captive network assistant is abandoned as too limiting and inconsistent, and SSE existed to serve it (dev_log: iPhone 10 CNA took SSE but not WebSocket). An SSE phone was also receive-only (`/events` is a one-way stream), so it could never send uplink, status or sync pings. Transport becomes WebSocket only. The captive portal's job is to get the phone to a real browser. Done: the SSE handler, `sseClients` and the SSE-first connection logic are deleted. `/events` is no longer a route (the server's catch-all serves the index page for unknown paths, as for any other).
