// Draw the Tambourin icons and README header — run via `deno task icons`.
// Writes ./public/favicon.ico (16, 32, 48), ./public/apple-touch-icon.png (180),
// ./public/icons/favicon-{16,32,48}.png and ./assets/readme-{light,dark}.svg.
// Browsers fetch /favicon.ico and
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

// --- README header: TAMBOURIN, where the O is the mark --------------------------
// Letters from the p5 sketch, on a 3x3 lattice (0..2). Letters are 4 grid units
// tall, so the O is exactly the mark's square. Weights are nudged up 1px from the
// cables (3.5 and 2) so the turned square survives GitHub shrinking it on phones.
const LETTERS: Record<string, number[][]> = {
  T: [[0, 0, 2, 0], [1, 0, 1, 2]],
  A: [[0, 2, 1, 0], [2, 2, 1, 0]],
  M: [[0, 0, 2, 0], [0, 0, 0, 2], [1, 0, 1, 1], [2, 0, 2, 2]],
  B: [[0, 0, 0, 2], [0, 1, 2, 1], [0, 2, 2, 2], [2, 1, 2, 2]],
  U: [[0, 2, 2, 2], [0, 0, 0, 2], [2, 0, 2, 2]],
  R: [[0, 0, 0, 2], [0, 0, 2, 0], [0, 1, 2, 1], [2, 0, 2, 1], [1, 1, 2, 2]],
  I: [[1, 0, 1, 2]],
  N: [[0, 0, 0, 2], [2, 0, 2, 2], [0, 0, 2, 2]],
};

// join segments that share endpoints into polylines, so corners are mitred
function chains(segs: number[][]): number[][][] {
  const left = segs.map((s) => [[s[0], s[1]], [s[2], s[3]]]);
  const eq = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
  const out: number[][][] = [];
  while (left.length) {
    const line = left.shift()!;
    for (let grew = true; grew;) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const [a, b] = left[i], head = line[0], tail = line[line.length - 1];
        if (eq(tail, a)) line.push(b);
        else if (eq(tail, b)) line.push(a);
        else if (eq(head, b)) line.unshift(a);
        else if (eq(head, a)) line.unshift(b);
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(line);
  }
  return out;
}

function readmeHeader(ink: string): string {
  const U = 20, k = 2 * U, gap = 2 * U, pad = U, heavy = 3.5, light = 2;
  const wordW = 9 * 2 * k + 8 * gap;
  const poke = k * Math.SQRT2 - k; // turned square's points beyond the letter line
  const w = wordW + 2 * pad;
  const h = Math.ceil((2 * k + 2 * poke + 2 * pad) / U) * U;
  const x0 = pad, y0 = (h - 2 * k) / 2;
  const f = (n: number) => +n.toFixed(2);
  const port = 5; // half-side: a 10px square port
  let g = "", holes = "";
  [..."TAMBOURIN"].forEach((ch, i) => {
    const ox = x0 + i * (2 * k + gap);
    if (ch === "O") {
      const cx = ox + k, cy = y0 + k, d = k * Math.SQRT2;
      g += `  <polygon points="${cx},${f(cy - d)} ${f(cx + d)},${cy} ${cx},${f(cy + d)} ${f(cx - d)},${cy}" stroke-width="${light}"/>\n`;
      g += `  <rect x="${ox}" y="${y0}" width="${2 * k}" height="${2 * k}" stroke-width="${heavy}" mask="url(#ports)"/>\n`;
      // square ports on the O's corners, outlined at the light weight; their
      // interiors are cut out of the O (a mask), so the ground shows through
      const corners = [[ox, y0], [ox + 2 * k, y0], [ox + 2 * k, y0 + 2 * k], [ox, y0 + 2 * k]];
      for (const [x, y] of corners) {
        g += `  <rect x="${x - port}" y="${y - port}" width="${2 * port}" height="${2 * port}" stroke-width="${light}"/>\n`;
        holes += `<rect x="${x - port}" y="${y - port}" width="${2 * port}" height="${2 * port}" fill="black"/>`;
      }
      return;
    }
    for (const line of chains(LETTERS[ch])) {
      const pts = line.map(([x, y]) => [ox + x * k, y0 + y * k]);
      // a diagonal stroke ending free on the top or bottom line is extended,
      // then clipped flat, so it meets the line square rather than slanted
      for (const [end, prev] of [[0, 1], [pts.length - 1, pts.length - 2]]) {
        const [x, y] = pts[end], [px, py] = pts[prev];
        if (x !== px && y !== py && (y === y0 || y === y0 + 2 * k)) {
          const len = Math.hypot(x - px, y - py);
          pts[end] = [f(x + (x - px) / len * heavy), f(y + (y - py) / len * heavy)];
        }
      }
      g += `  <polyline points="${pts.map((p) => p.join(",")).join(" ")}" stroke-width="${heavy}" clip-path="url(#line)"/>\n`;
    }
  });
  // the clip band is the letters' cap height to baseline, outer stroke edges
  const clip = `<clipPath id="line"><rect x="0" y="${y0 - heavy / 2}" width="${w}" height="${2 * k + heavy}"/></clipPath>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Tambourin">\n` +
    `<defs>${clip}<mask id="ports"><rect width="${w}" height="${h}" fill="white"/>${holes}</mask></defs>\n` +
    `<g fill="none" stroke="${ink}" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="10">\n${g}</g>\n</svg>\n`;
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
await Deno.mkdir("./assets", { recursive: true });
await Deno.writeTextFile("./assets/readme-light.svg", readmeHeader("#3f3e3b"));
await Deno.writeTextFile("./assets/readme-dark.svg", readmeHeader("#e0e0e0"));
console.log("✓ public/favicon.ico, public/apple-touch-icon.png, public/icons/favicon-{16,32,48}.png");
console.log("✓ assets/readme-{light,dark}.svg");
