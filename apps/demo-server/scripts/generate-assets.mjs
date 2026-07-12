/**
 * Generates the demo's committed binary assets from code, so the repo needs
 * no art pipeline: a 8×2-tile 32px tileset (tanks, shell, explosion, spark,
 * wall) rendered as pixel art into a PNG, the matching Tiled `.tsj`, and
 * three tiny WAV sound effects. Re-run with `node scripts/generate-assets.mjs`
 * after editing; the outputs are committed.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "..", "assets");

// ---------------------------------------------------------------------------
// Tileset layout (32px tiles, 8 columns × 2 rows). Tile id = row-major index.
// 0/1  tank green (track animation frames)
// 2/3  tank blue
// 4/5  tank red
// 6/7  tank yellow
// 8    shell
// 9-12 explosion animation frames
// 13   spark particle
// 14   wall block
// 15   floor decal
// ---------------------------------------------------------------------------
const TILE = 32;
const COLS = 8;
const ROWS = 2;
const W = TILE * COLS;
const H = TILE * ROWS;

const rgba = new Uint8Array(W * H * 4);

function put(x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = a;
}

function rect(tile, x0, y0, w, h, color) {
  const tx = (tile % COLS) * TILE;
  const ty = Math.floor(tile / COLS) * TILE;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      put(tx + x, ty + y, color);
    }
  }
}

function disc(tile, cx, cy, radius, color) {
  const tx = (tile % COLS) * TILE;
  const ty = Math.floor(tile / COLS) * TILE;
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      if (x * x + y * y <= radius * radius) {
        put(tx + cx + x, ty + cy + y, color);
      }
    }
  }
}

/**
 * Draws one tank tile facing +x (vecs rotation 0). `phase` offsets the track
 * lug pattern so two frames animate the tracks while driving.
 */
function tank(tile, body, dark, phase) {
  const tread = [40, 40, 46];
  const lug = [90, 90, 100];
  rect(tile, 4, 4, 24, 6, tread); // top track
  rect(tile, 4, 22, 24, 6, tread); // bottom track
  for (let x = 4 + phase; x < 28; x += 4) {
    rect(tile, x, 4, 2, 6, lug);
    rect(tile, x, 22, 2, 6, lug);
  }
  rect(tile, 6, 10, 20, 12, body); // hull
  rect(tile, 6, 10, 20, 2, dark); // hull shading
  disc(tile, 15, 16, 5, dark); // turret
  rect(tile, 15, 14, 14, 4, dark); // barrel toward +x
}

const GREEN = [
  [96, 180, 80],
  [56, 120, 48],
];
const BLUE = [
  [90, 140, 220],
  [50, 90, 160],
];
const RED = [
  [212, 90, 80],
  [150, 50, 44],
];
const YELLOW = [
  [220, 190, 80],
  [160, 130, 40],
];

[GREEN, BLUE, RED, YELLOW].forEach(([body, dark], index) => {
  tank(index * 2, body, dark, 0);
  tank(index * 2 + 1, body, dark, 2);
});

// 8: shell — a small bright slug with a tracer tail toward -x.
rect(8, 8, 15, 10, 2, [255, 200, 120, 160]);
disc(8, 20, 16, 4, [255, 240, 200]);
disc(8, 20, 16, 2, [255, 255, 255]);

// 9-12: explosion frames — expanding fireball that fades out.
const FIRE = [
  [255, 255, 210],
  [255, 200, 90],
  [240, 120, 50],
  [120, 60, 40],
];
[9, 10, 11, 12].forEach((tile, step) => {
  const radius = 5 + step * 3;
  disc(tile, 16, 16, radius, [...FIRE[Math.min(step + 1, 3)], 220 - step * 40]);
  disc(tile, 16, 16, Math.max(2, radius - 4), [...FIRE[step], 235 - step * 40]);
});

// 13: spark particle — a soft bright dot.
disc(13, 16, 16, 6, [255, 190, 90, 140]);
disc(13, 16, 16, 3, [255, 240, 190]);

// 14: wall block — mortared brick.
rect(14, 0, 0, 32, 32, [82, 86, 96]);
for (let row = 0; row < 4; row++) {
  rect(14, 0, row * 8, 32, 1, [58, 60, 68]);
  const offset = row % 2 === 0 ? 0 : 8;
  for (let x = offset; x < 32; x += 16) {
    rect(14, x, row * 8, 1, 8, [58, 60, 68]);
  }
}
rect(14, 0, 0, 32, 1, [104, 108, 118]);

// 15: floor decal — a faint plate for arena decoration.
rect(15, 2, 2, 28, 28, [40, 44, 52, 90]);
rect(15, 4, 4, 24, 24, [34, 38, 44, 90]);

// --- PNG encoding (RGBA8, no filter) ---------------------------------------
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(
    type.split("").map((c) => c.charCodeAt(0)),
    4
  );
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(width, height, pixels) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

mkdirSync(join(ASSETS, "tilesets"), { recursive: true });
writeFileSync(join(ASSETS, "tilesets", "arena.png"), png(W, H, rgba));

// --- Tiled tileset (.tsj) ----------------------------------------------------
const tsj = {
  columns: COLS,
  image: "arena.png",
  imagewidth: W,
  imageheight: H,
  margin: 0,
  name: "arena",
  spacing: 0,
  tilecount: COLS * ROWS,
  tiledversion: "1.10.2",
  tileheight: TILE,
  tilewidth: TILE,
  type: "tileset",
  version: "1.10",
  tiles: [
    {
      id: 0,
      class: "TankGreen",
      animation: [
        { tileid: 0, duration: 120 },
        { tileid: 1, duration: 120 },
      ],
    },
    {
      id: 2,
      class: "TankBlue",
      animation: [
        { tileid: 2, duration: 120 },
        { tileid: 3, duration: 120 },
      ],
    },
    {
      id: 4,
      class: "TankRed",
      animation: [
        { tileid: 4, duration: 120 },
        { tileid: 5, duration: 120 },
      ],
    },
    {
      id: 6,
      class: "TankYellow",
      animation: [
        { tileid: 6, duration: 120 },
        { tileid: 7, duration: 120 },
      ],
    },
    { id: 8, class: "Shell" },
    {
      id: 9,
      class: "Explosion",
      animation: [
        { tileid: 9, duration: 70 },
        { tileid: 10, duration: 70 },
        { tileid: 11, duration: 70 },
        { tileid: 12, duration: 70 },
      ],
    },
    { id: 13, class: "Spark" },
    { id: 14, class: "Wall" },
    { id: 15, class: "Floor" },
  ],
};
writeFileSync(join(ASSETS, "tilesets", "arena.tsj"), `${JSON.stringify(tsj, null, 2)}\n`);

// --- WAV sound effects -------------------------------------------------------
const SAMPLE_RATE = 22050;

function wav(samples) {
  const data = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    data[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
  }
  const bytes = new Uint8Array(44 + data.length * 2);
  const view = new DataView(bytes.buffer);
  const writeStr = (offset, text) =>
    text.split("").forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + data.length * 2, true);
  writeStr(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, data.length * 2, true);
  bytes.set(new Uint8Array(data.buffer), 44);
  return bytes;
}

function tone(duration, frequency, { decay = 8, square = false, slide = 0 } = {}) {
  const length = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(length);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    phase += ((frequency + slide * t) * 2 * Math.PI) / SAMPLE_RATE;
    const value = square ? Math.sign(Math.sin(phase)) * 0.6 : Math.sin(phase);
    samples[i] = value * Math.exp(-decay * t) * 0.6;
  }
  return samples;
}

function noise(duration, { decay = 6 } = {}) {
  const length = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(length);
  let last = 0;
  let seed = 0x2f6e2b1;
  for (let i = 0; i < length; i++) {
    // Deterministic xorshift noise, low-pass filtered for a rumble.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const white = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    last = last * 0.92 + white * 0.08;
    samples[i] = last * 8 * Math.exp((-decay * i) / SAMPLE_RATE);
  }
  return samples;
}

mkdirSync(join(ASSETS, "audio"), { recursive: true });
writeFileSync(
  join(ASSETS, "audio", "fire.wav"),
  wav(tone(0.12, 720, { decay: 22, square: true, slide: -1800 }))
);
writeFileSync(join(ASSETS, "audio", "explosion.wav"), wav(noise(0.6, { decay: 7 })));
writeFileSync(
  join(ASSETS, "audio", "bounce.wav"),
  wav(tone(0.06, 340, { decay: 40, slide: -900 }))
);

console.log("assets written to", ASSETS);
