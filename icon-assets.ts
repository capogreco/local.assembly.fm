// Draw the Tambourin icons — run via `deno task icons`.
// Writes ./public/favicon.ico (16, 32, 48), ./public/apple-touch-icon.png (180)
// and ./public/icons/favicon-{16,32,48}.png. Browsers fetch /favicon.ico and
// /apple-touch-icon.png from the root by default, so no <link> tags are needed.
//
// Spec: notes/identity.md (the mark; favicon and app icons).
// Small sizes are drawn pixel by pixel, not scaled down:
//   16px      both squares at 1px, no T
//   32, 48px  both squares at 1px, with T
// All on the paper tile, mark inset 1px, centred between the two middle pixels.
// 180px is the full mark: square 2.5 units, turned square 1, T, corner ports.

const PAPER = [0xf6, 0xf4, 0xee];
const INK = [0x3f, 0x3e, 0x3b];

type Image = { size: number; rgb: Uint8Array };

function blank(size: number): Image {
  const rgb = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) rgb.set(PAPER, i * 3);
  return { size, rgb };
}

// --- small sizes, pixel by pixel ----------------------------------------------
function small(N: number, tee: boolean): Image {
  const img = blank(N);
  const c = (N - 1) / 2, d = N / 2 - 1, h = Math.round(d / Math.SQRT2 - 0.5) + 0.5;
  const put = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < N && y < N) img.rgb.set(INK, (y * N + x) * 3);
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const ax = Math.abs(x - c), ay = Math.abs(y - c);
      if (Math.max(ax, ay) === h) put(x, y); // square
      if (ax + ay === d) put(x, y); // turned square, one step per row
    }
  }
  if (tee) {
    const half = Math.floor(h / 2), top = Math.round(c - half);
    for (let x = Math.ceil(c - half); x <= Math.floor(c + half); x++) put(x, top);
    for (let y = top; y <= c + half; y++) { put(Math.floor(c), y); put(Math.ceil(c), y); }
  }
  return img;
}

// --- large sizes, antialiased by supersampling ---------------------------------
function full(px: number): Image {
  const img = blank(px);
  const NATIVE = 120, UNIT = 20, s = px / NATIVE, c = px / 2;
  const h = 2 * UNIT * s, d = h * Math.SQRT2;
  const wH = 2.5 * s, wL = 1 * s;
  const half = UNIT * s; // T crossbar is 2 units wide
  const p = Math.max(3.5 * s, 1.5), pw = Math.max(wL, 0.75);
  const corners = [[c - h, c - h], [c + h, c - h], [c + h, c + h], [c - h, c + h]];

  // 1 = ink, 0 = paper, at one sample point
  const sample = (x: number, y: number): number => {
    for (const [px_, py] of corners) {
      const ax = Math.abs(x - px_), ay = Math.abs(y - py);
      if (Math.max(ax, ay) <= p + pw / 2) return Math.max(ax, ay) >= p - pw / 2 ? 1 : 0;
    }
    const ax = Math.abs(x - c), ay = Math.abs(y - c);
    if (Math.abs(Math.max(ax, ay) - h) <= wH / 2) return 1;
    if (Math.abs(ax + ay - d) <= (wL / 2) * Math.SQRT2) return 1;
    const t = wL / 2;
    if (Math.abs(y - (c - half)) <= t && Math.abs(x - c) <= half + t) return 1;
    if (Math.abs(x - c) <= t && y >= c - half - t && y <= c + half + t) return 1;
    return 0;
  };

  const SS = 8;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let ink = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) ink += sample(x + (i + 0.5) / SS, y + (j + 0.5) / SS);
      }
      const a = ink / (SS * SS);
      for (let k = 0; k < 3; k++) img.rgb[(y * px + x) * 3 + k] = Math.round(PAPER[k] + (INK[k] - PAPER[k]) * a);
    }
  }
  return img;
}

// --- PNG and ICO encoding ------------------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function png({ size, rgb }: Image): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size); v.setUint32(4, size);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const raw = new Uint8Array(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) raw.set(rgb.subarray(y * size * 3, (y + 1) * size * 3), y * (size * 3 + 1) + 1);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array()),
  ];
  return concat(parts);
}

function ico(entries: { size: number; png: Uint8Array }[]): Uint8Array {
  const head = new Uint8Array(6 + 16 * entries.length);
  const v = new DataView(head.buffer);
  v.setUint16(2, 1, true); v.setUint16(4, entries.length, true);
  let offset = head.length;
  entries.forEach((e, i) => {
    const o = 6 + 16 * i;
    head[o] = e.size; head[o + 1] = e.size;
    v.setUint16(o + 4, 1, true); v.setUint16(o + 6, 32, true);
    v.setUint32(o + 8, e.png.length, true); v.setUint32(o + 12, offset, true);
    offset += e.png.length;
  });
  return concat([head, ...entries.map((e) => e.png)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// --- write ---------------------------------------------------------------------
const smalls = [
  { size: 16, png: await png(small(16, false)) },
  { size: 32, png: await png(small(32, true)) },
  { size: 48, png: await png(small(48, true)) },
];
await Deno.mkdir("./public/icons", { recursive: true });
for (const e of smalls) await Deno.writeFile(`./public/icons/favicon-${e.size}.png`, e.png);
await Deno.writeFile("./public/favicon.ico", ico(smalls));
await Deno.writeFile("./public/apple-touch-icon.png", await png(full(180)));
console.log("✓ public/favicon.ico, public/apple-touch-icon.png, public/icons/favicon-{16,32,48}.png");
