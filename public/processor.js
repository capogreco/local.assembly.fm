/**
 * Simplified Voice Worklet — Formant + Zing Synthesis
 *
 * Ported from voice.assembly.fm reference implementation.
 * Runs its own internal master phasor (no external phasor worklet).
 * Parameters controlled via message port with portamento smoothing.
 */

class VoiceProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency",  defaultValue: 220, automationRate: "k-rate" },
      { name: "vowelX",     defaultValue: 0.5, automationRate: "k-rate" },
      { name: "vowelY",     defaultValue: 0.5, automationRate: "k-rate" },
      { name: "zingAmount", defaultValue: 0.5, automationRate: "k-rate" },
      { name: "zingMorph",  defaultValue: 0.5, automationRate: "k-rate" },
      { name: "symmetry",   defaultValue: 0.5, automationRate: "k-rate" },
      { name: "amplitude",  defaultValue: 0.1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();

    this.masterPhase = 0.0;
    this.fundamentalFreq = 220.0;
    this.sr = sampleRate;

    this.twoPi = 2 * Math.PI;
    this.halfPi = Math.PI / 2;

    // Portamento targets and current values
    this.targets = {
      frequency: 220, vowelX: 0.5, vowelY: 0.5,
      zingAmount: 0.5, zingMorph: 0.5, symmetry: 0.5, amplitude: 0.1,
    };
    this.current = { ...this.targets };

    // Portamento alpha: ~50ms exponential smoothing
    this.portamentoAlpha = 1 - Math.exp(-1 / (this.sr * 0.05));

    // Vowel formant frequency corners (F1, F2, F3 in Hz)
    this.vowelFreqCorners = {
      backClose:  [240,  596,  2400], // u
      backOpen:   [730,  1090, 2440], // open-o
      frontClose: [270,  2290, 3010], // i
      frontOpen:  [850,  1610, 2850], // ae
    };

    // Vowel formant amplitude corners
    this.vowelAmpCorners = {
      backClose:  [0.3, 0.2, 0.1],
      backOpen:   [1.0, 0.5, 0.2],
      frontClose: [0.4, 1.0, 0.3],
      frontOpen:  [0.8, 0.7, 0.3],
    };

    // Current interpolated formant state
    this.formantFreqs = [800, 1150, 2900];
    this.formantAmps  = [0.6, 0.6, 0.25];

    // Formant carriers with Le Brun cross-fade assignments
    this.formants = [
      {
        targetFreq: 800, bandwidth: 80, amplitude: 0.8,
        carrierEven: { harmonicNum: 4, amplitude: 0.0 },
        carrierOdd:  { harmonicNum: 3, amplitude: 0.8 },
      },
      {
        targetFreq: 1150, bandwidth: 90, amplitude: 0.6,
        carrierEven: { harmonicNum: 6, amplitude: 0.0 },
        carrierOdd:  { harmonicNum: 5, amplitude: 0.6 },
      },
      {
        targetFreq: 2900, bandwidth: 120, amplitude: 0.2,
        carrierEven: { harmonicNum: 14, amplitude: 0.0 },
        carrierOdd:  { harmonicNum: 13, amplitude: 0.2 },
      },
    ];

    this.updateFormantCarriers();

    // Internal gain compensation
    this.formantGain = 3.0;
    this.zingGain = 0.4;
    this.modDepth = 0.5;

    // Message port for parameter updates
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "params") {
        for (const key of Object.keys(this.targets)) {
          if (msg[key] !== undefined) {
            this.targets[key] = msg[key];
          }
        }
      }
    };
  }

  // --- Vowel interpolation ---

  updateVowelFormants(vowelX, vowelY) {
    const fc = this.vowelFreqCorners;
    const ac = this.vowelAmpCorners;

    for (let f = 0; f < 3; f++) {
      const backFreq  = fc.backClose[f] * (1 - vowelY) + fc.backOpen[f] * vowelY;
      const frontFreq = fc.frontClose[f] * (1 - vowelY) + fc.frontOpen[f] * vowelY;
      this.formantFreqs[f] = backFreq * (1 - vowelX) + frontFreq * vowelX;

      const backAmp  = ac.backClose[f] * (1 - vowelY) + ac.backOpen[f] * vowelY;
      const frontAmp = ac.frontClose[f] * (1 - vowelY) + ac.frontOpen[f] * vowelY;
      this.formantAmps[f] = backAmp * (1 - vowelX) + frontAmp * vowelX;

      this.formants[f].targetFreq = this.formantFreqs[f];
      this.formants[f].amplitude  = this.formantAmps[f];
    }

    this.updateFormantCarriers();
  }

  // --- Le Brun cross-fade carrier assignment ---

  updateFormantCarriers(freq) {
    const fundamentalFreq = freq || this.fundamentalFreq;
    if (fundamentalFreq <= 0) return;

    for (const formant of this.formants) {
      const targetRatio = formant.targetFreq / fundamentalFreq;
      const lower = Math.floor(targetRatio);
      const upper = Math.ceil(targetRatio);

      let evenH, oddH;
      if (lower % 2 === 0) { evenH = lower; oddH = upper; }
      else                  { oddH = lower; evenH = upper; }

      evenH = Math.max(2, evenH + (evenH % 2));
      oddH  = Math.max(1, oddH - ((oddH + 1) % 2));

      const evenFreq = evenH * fundamentalFreq;
      const oddFreq  = oddH * fundamentalFreq;
      const evenDist = Math.abs(formant.targetFreq - evenFreq);
      const oddDist  = Math.abs(formant.targetFreq - oddFreq);
      const total    = evenDist + oddDist;

      let evenW = 0, oddW = 1;
      if (total > 0) { evenW = oddDist / total; oddW = evenDist / total; }

      formant.carrierEven.harmonicNum = evenH;
      formant.carrierEven.amplitude   = evenW * formant.amplitude;
      formant.carrierOdd.harmonicNum  = oddH;
      formant.carrierOdd.amplitude    = oddW * formant.amplitude;
    }
  }

  // --- Modulator (fundamental sine) ---

  generateModulator(phasor) {
    return Math.sin(this.twoPi * phasor);
  }

  // --- FM formant synthesis path ---

  generateFormantSynthesis(phasor, modulator, symmetryValue) {
    let total = 0, f1 = 0, f2 = 0, f3 = 0;
    for (let i = 0; i < this.formants.length; i++) {
      const f = this.formants[i];
      const sp = this.applySymmetry(phasor, symmetryValue);
      const useCos = i === 1; // F2 uses cosine

      const even = this.generateFMCarrier(
        sp, f.carrierEven.harmonicNum, f.carrierEven.amplitude,
        f.bandwidth / 100.0, modulator, useCos
      );
      const odd = this.generateFMCarrier(
        sp, f.carrierOdd.harmonicNum, f.carrierOdd.amplitude,
        f.bandwidth / 100.0, modulator, useCos
      );
      const formantOutput = even + odd;
      total += formantOutput;
      if (i === 0) f1 = formantOutput;
      if (i === 1) f2 = formantOutput;
      if (i === 2) f3 = formantOutput;
    }
    return { total: total * 0.1, f1: f1 * 0.1, f2: f2 * 0.1, f3: f3 * 0.1 };
  }

  generateFMCarrier(phasor, harmonicNum, amplitude, modIndex, modulator, useCos) {
    if (amplitude <= 0 || harmonicNum <= 0) return 0;
    const carrierPhase = this.twoPi * ((phasor * harmonicNum) % 1.0);
    const modulated = carrierPhase + modIndex * modulator;
    return amplitude * (useCos ? Math.cos(modulated) : Math.sin(modulated));
  }

  // --- Zing synthesis path (ring mod / AM) ---

  generateZingSynthesis(phasor, morphValue, modDepthValue, symmetryValue) {
    const fundamental = this.generateWaveform(
      this.applySymmetry(phasor, symmetryValue)
    );

    let total = 0, f1 = 0, f2 = 0, f3 = 0;
    for (let i = 0; i < 3; i++) {
      const harmonic = this.generateFormantUPL(i, symmetryValue);
      const ring = this.applyMorphingSynthesis(
        fundamental, harmonic, morphValue, modDepthValue
      );
      const out = ring * this.formantAmps[i];
      total += out;
      if (i === 0) f1 = out;
      if (i === 1) f2 = out;
      if (i === 2) f3 = out;
    }
    return { total, f1, f2, f3 };
  }

  generateFormantUPL(formantIndex, symmetryValue) {
    const targetFreq = this.formantFreqs[formantIndex];
    const targetRatio = targetFreq / this.fundamentalFreq;
    const maxRatio = Math.floor((this.sr * 0.45) / this.fundamentalFreq);
    const safeRatio = Math.min(targetRatio, maxRatio);

    const lower = Math.floor(safeRatio);
    const upper = lower + 1;
    const crossfade = safeRatio - lower;

    const lowerPhase = this.applySymmetry((this.masterPhase * lower) % 1.0, symmetryValue);
    const upperPhase = this.applySymmetry((this.masterPhase * upper) % 1.0, symmetryValue);
    const useCos = formantIndex === 1;

    const lowerWave = this.generateWaveform(lowerPhase, useCos);
    const upperWave = this.generateWaveform(upperPhase, useCos);
    return lowerWave * (1.0 - crossfade) + upperWave * crossfade;
  }

  applyMorphingSynthesis(fundamental, harmonic, morphValue, modDepthValue) {
    const amComp = 2.0 / 3.0;

    if (Math.abs(morphValue) < 0.001) {
      return fundamental * harmonic;
    }

    const absMorph = Math.abs(morphValue);
    const ringW = Math.cos(absMorph * this.halfPi);
    const amW   = Math.sin(absMorph * this.halfPi);
    const ring  = fundamental * harmonic;

    let am;
    if (morphValue > 0) {
      am = (1 + fundamental * modDepthValue) * harmonic * amComp;
    } else {
      am = fundamental * (1 + harmonic * modDepthValue) * amComp;
    }

    const totalW = ringW + amW;
    const scale = 1.0 / Math.max(totalW, 1.0);
    return (ring * ringW + am * amW) * scale;
  }

  // --- Shared utilities ---

  applySymmetry(phase, symmetry) {
    const skew = Math.max(0.01, Math.min(0.99, symmetry));
    if (phase < 0.5) {
      return (phase / 0.5) * skew;
    }
    return skew + ((phase - 0.5) / 0.5) * (1.0 - skew);
  }

  generateWaveform(phase, useCosine) {
    return useCosine
      ? Math.cos(this.twoPi * phase)
      : Math.sin(this.twoPi * phase);
  }

  // --- Process loop ---

  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const out = output[0];
    const outF1 = output[1] || null;
    const outF2 = output[2] || null;
    const outF3 = output[3] || null;
    const blockSize = out.length;
    const alpha = this.portamentoAlpha;

    // Read AudioParam values as targets (they override message port targets)
    const paramNames = ["frequency", "vowelX", "vowelY", "zingAmount", "zingMorph", "symmetry", "amplitude"];
    for (const name of paramNames) {
      const p = parameters[name];
      if (p && p.length > 0) {
        // Only use AudioParam if it's been explicitly set (non-default)
        // Message port targets take priority for server-driven control
      }
    }

    for (let s = 0; s < blockSize; s++) {
      // Portamento smoothing toward targets
      for (const key of paramNames) {
        this.current[key] += alpha * (this.targets[key] - this.current[key]);
      }

      const freq      = this.current.frequency;
      const vowelX    = this.current.vowelX;
      const vowelY    = this.current.vowelY;
      const amplitude = this.current.amplitude;
      const zingAmt   = this.current.zingAmount;
      const zingMorph = this.current.zingMorph;
      const symmetry  = this.current.symmetry;

      if (freq <= 0 || amplitude <= 0) {
        out[s] = 0;
        if (outF1) outF1[s] = 0;
        if (outF2) outF2[s] = 0;
        if (outF3) outF3[s] = 0;
        continue;
      }

      // Update frequency-dependent state
      if (freq !== this.fundamentalFreq) {
        this.fundamentalFreq = freq;
        this.updateFormantCarriers(freq);
      }

      // Update vowel formants
      this.updateVowelFormants(vowelX, vowelY);

      // Advance master phasor
      this.masterPhase = (this.masterPhase + freq / this.sr) % 1.0;

      // Generate modulator
      const modulator = this.generateModulator(this.masterPhase);

      // FM formant path
      const formant = this.generateFormantSynthesis(this.masterPhase, modulator, symmetry);

      // Zing path
      const bipolarMorph = (zingMorph - 0.5) * 2.0;
      const zing = this.generateZingSynthesis(this.masterPhase, bipolarMorph, this.modDepth, symmetry);

      // Blend and scale
      const blended = formant.total * this.formantGain * (1.0 - zingAmt)
                     + zing.total * this.zingGain * zingAmt;

      out[s] = blended * 10.0 * amplitude;

      // Per-formant channels for oscilloscope
      if (outF1) {
        const b = formant.f1 * this.formantGain * (1.0 - zingAmt) + zing.f1 * this.zingGain * zingAmt;
        outF1[s] = b * 10.0 * amplitude + (Math.random() * 2 - 1) * 0.003;
      }
      if (outF2) {
        const b = formant.f2 * this.formantGain * (1.0 - zingAmt) + zing.f2 * this.zingGain * zingAmt;
        outF2[s] = b * 10.0 * amplitude + (Math.random() * 2 - 1) * 0.003;
      }
      if (outF3) {
        const b = formant.f3 * this.formantGain * (1.0 - zingAmt) + zing.f3 * this.zingGain * zingAmt;
        outF3[s] = b * 10.0 * amplitude + (Math.random() * 2 - 1) * 0.003;
      }
    }

    return true;
  }
}

registerProcessor("voice-processor", VoiceProcessor);
