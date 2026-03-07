# Melbourne / Darebin Creek — Cicada Species Synthesis Reference

Victoria hosts ~49 documented species (est. 70+), 86% shared with NSW/ACT.
Peak season in inner Melbourne: **November through January**.
Minimum calling temperature: **18.5°C** (body temp, Greengrocer).

---

## 1. Cyclochila australasiae — Greengrocer / Yellow Monday

**Status:** Confirmed in Melbourne northern suburbs. One of the two dominant large species.
**Size:** Forewing 50-58mm (large).

### Acoustic Parameters
- **Carrier frequency**: **4.3 kHz** (Helmholtz resonance of abdominal air sac)
- **Rib frequencies**: 4.37, 4.19, 3.92, 3.17 kHz (descending as 4 ribs buckle in sequence)
- **OUT pulse**: ~6.54 kHz, >20 dB quieter than IN pulses
- **Pulse rate**: **234 Hz** combined (117 Hz per side, alternating L/R)
- **Q factor**: 12.5 combined (tymbal Q~9.3 + air sac Q~3.4)
- **Volume**: ~120 dB at close range
- **Bandwidth**: Narrow/tonal — near pure-tone quality

### Temporal Pattern
- Loud metallic continuous drone OR pulsed with detectable pauses
- Groups chorus with synchronized fragmented build-up phases
- "Pure tone elements" — the most tonal of the Melbourne species

### Season & Timing
- Adults: October to January (peak November)
- Active: afternoon and dusk on warm days, also morning if very hot
- Threshold: 18.5°C body temperature

### Synthesis Notes
The **reference species** for cicada synthesis — best studied acoustically.
~4.3 kHz carrier with 234 Hz pulse rate. High Q gives tonal character.
Sequential rib buckling creates micro-temporal structure within pulse groups.

---

## 2. Psaltoda moerens — Redeye

**Status:** Confirmed in Melbourne, "restricted to north and south of metropolitan area."
**Size:** Forewing 42-52mm (large).

### Acoustic Parameters
- **Carrier frequency**: est. 3-5 kHz (large Psaltoda, not precisely measured)
- **Pulse rate**: est. 200-400 Hz (congener P. claripennis = 224 Hz muscle rate)
- **Volume**: up to 120 dB in chorus
- **Bandwidth**: Broader than Greengrocer — harmonics, "growly" quality

### Temporal Pattern — TWO-PHASE SONG
1. **Growl→Roar**: rising volume, rich harmonics, "revving" quality (2-12 reps, typically ~6)
2. **Yodel**: melodious frequency modulation caused by **flexing abdomen upward** —
   physically changes Helmholtz cavity volume → swept resonant frequency
3. Followed by rattling continuous call

### Season & Timing
- Adults: November to March
- Active during warm daylight hours

### Synthesis Notes
The **most complex** local species to synthesise. The yodelling is physical FM —
abdomen flex changes Helmholtz volume, sweeping the formant resonance.
Model as time-varying biquad center frequency during yodel phase.
The growl→roar→yodel envelope is the defining character.

---

## 3. Yoyetta celis — Silver Princess / Pale Ambertail

**Status:** Confirmed in Melbourne, including city gardens. Associated with tea-tree/Melaleuca.
Darebin Creek has this habitat.
**Size:** Forewing 23-31mm (small-medium).

### Acoustic Parameters
- **Carrier frequency**: est. **6-10 kHz** (smaller body = higher freq)
- **Volume**: Quiet relative to large species
- **Bandwidth**: Unknown, likely narrowish

### Temporal Pattern
- **"zip zip zip zip zip zip..."** — quiet series of discrete phrases
- Males sing in **unison** (synchronized)
- Described as "strident chirping"

### Season & Timing
- Adults: September to February (one of first to emerge each season)
- Active in tea-tree/Melaleuca clumps

### Synthesis Notes
Short discrete pulses rather than continuous drone. High carrier.
Multiple males in synchrony — a different chorus texture than the
large species (coordinated pulses rather than merged drone).

---

## 4. Galanga labeculata — Double-spotted Cicada

**Status:** Possible in Melbourne area — confirmed in NE Victoria, prolific in Sydney suburbs.
**Size:** Medium.

### Acoustic Parameters
- **Temporal pattern (day)**: Long buzz rising in pitch over 5-10 seconds, ending in abrupt "tick"
- **Temporal pattern (dusk)**: Monotonous buzz punctuated by clicks
- **Calling interval**: Every 30 seconds to 5 minutes

### Season & Timing
- Adults: September to April (very long season)

### Synthesis Notes
The **pitch-rising buzz** is distinctive — continuous upward frequency sweep
(~5-10 second ramp) terminated by an impulsive transient. The dusk call
adds rhythmic click punctuation to a drone.

---

## 5. Gelidea torrida complex — Southern Spotted Cicada / Twin-spotted Creaker / Tasman Ticker

**Status:** Coastal Victoria. Possibly marginal for inner Melbourne.
**Size:** Forewing 19-26mm (small).

### Two Forms
- **Twin-spotted Creaker**: soft "urr-chip" — noise burst + sharp transient
- **Tasman Ticker**: rapid ticking — impulsive transients
- Both: "interesting high-pitched rattling"

---

## 6. Atrapsalta encaustica — Black Squeaker

**Status:** Likely in Melbourne. Tiny — "size of your little fingernail."

### Acoustic Parameters
- **Carrier frequency**: est. **>10 kHz** (possibly 12-16 kHz)
- **Volume**: Very quiet, easily overlooked
- **Pattern**: High-pitched squeaking

---

## 7. Pauropsalta mneme — Ticker

**Status:** Confirmed in central Victoria.

### Acoustic Parameters
- **Pattern**: "Strident hiss + crisp ticks"
- **Timing**: Particularly active ~20 minutes after sunset (crepuscular)
- **Season**: Late September to early January

---

## Species NOT in Melbourne

- **Aleeta curvicosta (Floury Baker)**: only to NSW south coast
- **Henicopsaltria eydouxii (Razor Grinder)**: only to Narooma NSW
- **Thopha saccata (Double Drummer)**: only to Moruya NSW
- **Psaltoda plaga (Black Prince)**: only to Bega NSW
- **Psaltoda claripennis (Clanger)**: only to Tamworth/Grafton NSW

---

## Synthesis Parameter Space (across Melbourne species)

| Parameter | Min | Max |
|-----------|-----|-----|
| Carrier freq | 3 kHz (Redeye) | >10 kHz (Black Squeaker) |
| Pulse rate | Discrete phrases (Silver Princess) | 234+ Hz continuous (Greengrocer) |
| Q / tonality | Broad/growly (Redeye) | Narrow/tonal Q~12.5 (Greengrocer) |
| Volume | Very quiet (Black Squeaker) | 120 dB (Greengrocer, Redeye) |
| Temporal | Continuous drone | Phrased "zip zip" | Rising sweep + tick |
| FM | None (Greengrocer) | Yodelling swept formant (Redeye) |
| Note duration | Short tick (~5ms) | Continuous (minutes) |

## Temperature Dependence

```
pulse_rate(T) ≈ pulse_rate(T_ref) × (T - T₀) / (T_ref - T₀)
```
- T₀ ≈ 4°C (extrapolated zero-rate temperature)
- ~0.5 Hz increase in chirp rate per °C (European data, broadly applicable)
- Hotter → faster muscle contraction → higher pulse rate → more continuous tone

## Sources

- dr-pop.net — Victorian cicada species accounts
- Museums Victoria — Greengrocer, Redeye collections
- Australian Museum — Greengrocer
- Young & Bennet-Clark 1995, 1997 — tymbal mechanics, Q factors, rib frequencies
- Bennet-Clark & Daws 1999 — 234 Hz pulse rate, energy measurements
- Bennet-Clark & Young 1994 — body size / frequency scaling
- ciclover.com — Melbourne recording, 18.5°C threshold
- Natural Newstead blog — central Victoria cicada identification
- dr-pop SoundCloud — 42 recordings of Victorian cicada species
