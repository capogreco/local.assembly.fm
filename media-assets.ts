// Write the test sample for buffer~ / play~ — run via `deno task media`.
// Writes ./public/media/test-phrase.wav: 3 s, mono, 48 kHz, 16-bit. Six
// pentatonic notes of 0.5 s each (a few harmonics, a short attack and decay),
// the last with a burst of noise, so a play~ position is audible as a pitch.
// Deterministic: the noise comes from a fixed-seed LCG.

const RATE = 48000;
const NOTE = 0.5; // seconds per note
const PITCHES = [220, 247.5, 275, 330, 366.7, 440]; // A pentatonic, just-ish
const samples = new Float32Array(Math.round(RATE * NOTE * PITCHES.length));

let seed = 12345;
function noise(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x80000000 - 1;
}

PITCHES.forEach((f, n) => {
  const start = Math.round(n * NOTE * RATE), len = Math.round(NOTE * RATE);
  const withNoise = n === PITCHES.length - 1;
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / RATE;
    const env = Math.min(1, t / 0.01) * Math.exp(-t * 4);
    let v = 0;
    for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * h);
    if (withNoise) { lp += 0.2 * (noise() - lp); v += lp; }
    samples[start + i] = 0.5 * env * v;
  }
});

function wav(data: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + data.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + data.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, data[i])) * 32767), true);
  return bytes;
}

await Deno.mkdir("./public/media", { recursive: true });
await Deno.writeFile("./public/media/test-phrase.wav", wav(samples));
console.log(`wrote public/media/test-phrase.wav (${samples.length} samples)`);
