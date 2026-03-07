# Darebin Creek / Thornbury — Bird Call Synthesis Reference

Area: Darebin Parklands, Thornbury, VIC, Australia
Riparian corridor along Darebin Creek — 70+ species recorded.
Sources: BirdLife Melbourne surveys, eBird hotspot L2552484, Friends of Darebin Parklands.

---

## 1. Australian Magpie — CAROLLING

**Freq:** F0 200Hz-2kHz. Carol syllables 1-1.5kHz fundamental, harmonics to 8kHz.
**Dual syrinx:** Left side mean 1.30kHz, right side mean 1.03kHz. Separation ~300Hz.
Can drop 3-4 octaves between consecutive notes.

**Temporal:** Carol syllables 400-650ms each, 4-5 slurred elements. Warble syllables <200ms.
**AM:** Rapid AM >100Hz from beat frequencies between two syrinx sources. Subharmonics at 0.5×f0.

**Envelope:** Carol notes: gradual attack (50-100ms), sustained 300-400ms, moderate decay.
Warble: percussive — short attack, brief sustain, quick decay.

**Synthesis:** Two detuned oscillators (L/R syrinx), 3-5 harmonics each.
Slow FM sweep (glissando, 1-4 octave range). AM at difference frequency.
Broadband noise bursts for connecting material.

**Ref:** PMC — Mechanisms of song production in the Australian magpie

---

## 2. Magpie-lark (Peewee) — DUET

**Freq:** F0 ~1.5-3kHz, harmonics to 6-8kHz. Metallic ringing quality.
**Temporal:** Interlocking duet — "pee-wee" (descending) + partner "wit!" (sharp).
Each note ~150-300ms. Partners offset by ~500ms.

**Envelope:** Sharp attack (<20ms), brief sustain, resonant ringing decay (50-100ms).
Bell-like — doesn't cut off but rings.

**Synthesis:** Narrow-band tone ~2kHz, 2-3 harmonics. Sharp percussive envelope.
Slight inharmonicity for metallic quality. Descending interval ~minor 3rd to P4.
Sequence as alternating two-voice phrases at 500ms offset.

---

## 3. Laughing Kookaburra — LAUGHING CHORUS

**Freq:** F0 300Hz-3kHz, dual syrinx. Broadband harmonics.
**Structure (5 elements):**
1. "Kooa" — low tonal chuckle, 300-800Hz
2. "Cackle" — transitional, building
3. "Rolling" — tremolo "oo-oo-oo", 5-10 reps/sec
4. "Ha-ha" — loud laugh, broadband, climax
5. Ending — descending

**Temporal:** Starts slow, accelerates to climax, decelerates. 10-60 seconds total.
**Envelope:** Individual "ha": sharp attack (~10ms), brief sustain (30-50ms), short decay.
Inter-note gaps shorten as tempo increases. Rolling section: tremolo at 5-10Hz.

**Synthesis:** FM with carrier 800-1500Hz. Accelerating percussive burst sequence.
Two detuned oscillator pairs for biphonation. Tremolo AM at 5-10Hz for rolling section.

---

## 4. Noisy Miner — CHIP / CHUR / ALARM

**Call types:**
- Chip contact: ~2-4kHz, 50-100ms, extremely percussive (<5ms attack)
- Chur alarm: 700-1500Hz, 100-200ms, harsh buzzy
- Aerial alarm: >2kHz, upward-slurred whistles
- Rate: 85-100 calls/minute

**Synthesis:** Chip: short burst of band-limited noise at ~3kHz.
Chur: sawtooth ~1kHz with bandpass filtering.
Aerial alarm: sine sweep 2→4kHz over 200ms. Overall character: busy, chattery.

---

## 5. Eastern Rosella — PIPING / METALLIC CHATTER

**Freq:** 1-5kHz. Contact "pee-ping" at 2-4kHz. Alarm "pink pink pink" metallic 2-5kHz.
**Temporal:** Contact: single/double note, 1-2 sec intervals. Alarm: 4-8 "pink" at 3-4/sec.

**Envelope:** Piping: moderate attack (20-30ms), clean sustain, moderate decay. Bell-like.
**Synthesis:** Nearly pure tone ~3kHz for piping. Rising interval minor 2nd to minor 3rd.
Ring modulation or narrow bandpass for metallic alarm.

---

## 6. Red Wattlebird — HARSH "YACK" / COUGH

**Freq:** 1.3-5.9kHz (louder at lower frequencies). Staccato call 1.1-2.2kHz.
**Temporal:** "Yac-a-yac": 2-3 syllables, 150ms each, 100ms gaps. Bouts of 3-8 reps.

**Envelope:** Rapid attack (<10ms), sustained 100-150ms, moderate resonant decay.
"Cough": explosive instant attack, no sustain, rapid exponential decay ~50ms.

**Synthesis:** Broadband source filtered through resonant LP ~2-3kHz. Non-sinusoidal, harsh.

---

## 7. Little Wattlebird — "COOKAY-COK" / CACKLING

**Freq:** ~1.5-6kHz. "Churr" 1.5-3kHz, cackling "jick" 2.5-5kHz.
**Temporal:** Three-syllable "cookay-cok" ~400-600ms. Single alarm "kwock".

**Synthesis:** Buzzy oscillator (noise-modulated sine) through formant filter bank.
Rapid percussive envelope. Multiple overlapping formant peaks 2-5kHz.

---

## 8. Grey Fantail — CASCADING SONG

**Freq:** 3-8kHz, peak energy 4-6kHz. High-pitched.
**Temporal:** Rapid descending cascade, 8-15 notes at 6-10 notes/sec. Phrase 1-2 sec.

**Envelope:** Very short notes: attack <5ms, decay ~20ms. Legato overlap between notes.
Overall phrase descends in both pitch and amplitude.

**Synthesis:** Rapid sequence of very short sine bursts descending ~7→4kHz.
Semitone to whole-tone intervals. sin⁴ pulse envelopes. Slight vibrato 2-3Hz.

---

## 9. Willie Wagtail — "SWEET PRETTY CREATURE"

**Freq:** 2-6kHz song, 4-7kHz alarm "chit-chit-chit".
**Temporal:** Song: 4-7 whistled notes, 1.5-2.5 sec. Melodic phrase.
Alarm: rapid 6-10 notes/sec. Nocturnal calling during moonlit breeding season.

**Envelope:** Song: moderate attack (15-25ms), brief sustain, gentle decay (30-50ms).
"Squeaky" quality from slight FM vibrato at 10-20Hz.

**Synthesis:** Near-sinusoidal tones 2-4 harmonics. Frequency glides between notes.
FM vibrato 10-20Hz for squeaky quality. Alarm: band-limited clicks at ~5kHz.

---

## 10. Rainbow Lorikeet — SCREECH / CHATTER

**Freq:** 1-8kHz, most energy 2-6kHz. Broadband screech with strong harmonics.
**Temporal:** In-flight screech 0.5-2 sec. Flock chatter "keet-keet-keet" 4-8 notes/sec.

**Envelope:** Screech: fast attack (<10ms), sustained, rough/noisy. Chatter: rapid percussive.
**Synthesis:** Sawtooth or noise-modulated carrier ~3-4kHz. Random FM jitter for harshness.
Flock: multiple instances at different rates/pitches panned across stereo.

---

## 11. Sulphur-crested Cockatoo — SCREECH

**Freq:** 0.5-6kHz, most energy 1-4kHz. Volume 120+ dB.
**Temporal:** Drawn-out screech 0.5-2 sec with ending inflection. Alarm: shorter, harsher.

**Envelope:** Fast attack (~20ms), long sustain, inflection in final 200-300ms.
Dense spectral content during sustain — not clean harmonics but intermodulated noise.

**Synthesis:** Broadband noise with multiple resonant formant peaks 1-4kHz.
Pitch bend ±500Hz over final 200ms. Extremely high amplitude.

---

## 12. Pied Currawong — "CURRA-WONG" / WOLF WHISTLE

**Freq:** 1-3kHz fundamental (whistle). Deep croak 300-800Hz.
**Temporal:** Three syllables: short / short / longer rising "wong". Wolf whistle: ascending glide.

**Envelope:** Clean whistled: moderate attack (30ms), good sustain, gentle decay. Ringing.
**Synthesis:** Near-pure tones 1.5-2.5kHz. Final syllable upward glide ~P4.
Wolf whistle: sine sweep 1.5→2.5kHz. Croak: ~500Hz with irregular AM, rich harmonics.

---

## 13. Grey Butcherbird — ROLLICKING PIPING SONG

**Freq:** 0.5-4kHz, primarily 1-3kHz. Remarkably pure tones.
**Temporal:** Musical piping notes 200-500ms. Songs up to 15 minutes. Duet/group singing.

**Envelope:** Piping: very clean onset (20ms), sustained pure tone, clean offset.
Exceptional tonal purity — studied by musicians.

**Synthesis:** Very clean sine waves 1-3kHz, minimal harmonics. Portamento between notes.
Intervals resemble human music (3rds, 4ths, 5ths). Harsh calls contrast with noisy source.

---

## 14. Superb Fairy-wren — HIGH-PITCHED TRILL

**Freq:** 4-10kHz. Among the highest-frequency songs in the area.
**Temporal:** Trill: 10-20 notes/sec, 1-3 sec phrases. Chatter song: variable, 2-5 sec.

**Envelope:** Trill notes ~20-50ms each, fast attack/decay, blur together into reeling sound.
Flat amplitude envelope across phrase (unlike fantail's descending cascade).

**Synthesis:** Rapid pure-tone bursts ~6-8kHz, 10-20Hz repetition rate.
Micro-tonal pitch wobble between notes. Tests temporal resolution limits.

---

## 15. Spotted Pardalote — TWO/THREE-NOTE WHISTLE

**Freq:** 3-7kHz. Penetrating, high.
**Temporal:** 2-3 note phrase every 3-8 sec. Repeated persistently for long periods — hundreds of times.

**Envelope:** Bell-like: moderate attack (20ms), brief sustain, gentle resonant decay.
**Synthesis:** Nearly pure sine ~5kHz. Two-note pattern high→low (~5.5→4.5kHz).
Simplest possible synthesis — the incessant regularity IS the character.

---

## 16. Crested Pigeon — WING WHISTLE (mechanical, non-vocal)

**Freq:** Tone 1: 1303±100Hz, Tone 2: 2937±209Hz. Plus atonal "clap".
**Temporal:** Three elements cycling with wingbeat at 6-10 Hz. Continuous during flight.

**Envelope:** Very short per-wingbeat pulses, near-instant onset/offset.
**Synthesis:** Two sine oscillators gated alternately at wingbeat rate.
Broadband noise bursts for "clap". Modulate rate for alarm vs normal flight.

---

## Parameter Space Summary (across all species)

| Parameter | Min | Max |
|-----------|-----|-----|
| Fundamental freq | 300Hz (Kookaburra) | 10kHz (Fairy-wren) |
| Harmonic richness | Near-sine (Pardalote) | Broadband noise (Cockatoo) |
| Note duration | 20ms (Fairy-wren) | 2000ms (Cockatoo) |
| Note rate | 0.5/s (Pardalote) | 20/s (Fairy-wren) |
| FM depth | 0 (Pardalote) | 4 octaves (Magpie leaps) |
| FM rate | <1Hz (glissando) | 10Hz (Kookaburra tremolo) |
| AM rate | 0 (sustained) | 100+Hz (Magpie biphonation) |
| Envelope attack | <5ms (Miner chip) | 100ms (Magpie carol) |
| Noise content | 0% (Pardalote) | 80%+ (Cockatoo screech) |
