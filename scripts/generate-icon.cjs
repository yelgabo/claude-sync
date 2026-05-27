// Generates assets/icon-1024.png — 1024x1024 rounded-square + circular sync arrow.
// Run: node scripts/generate-icon.cjs
const { PNG } = require('pngjs');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const CORNER_RADIUS = 224;
const BG = { r: 0x4F, g: 0x46, b: 0xE5 };       // indigo
const FG = { r: 0xFF, g: 0xFF, b: 0xFF };       // white

const cx = (SIZE - 1) / 2;
const cy = (SIZE - 1) / 2;
const RING_INNER = 280;
const RING_OUTER = 360;
const GAP_ANGLE_HALF = Math.PI / 12;             // 15° gap on each side of the arrowheads

// Sub-pixel sampling for smooth edges: 3x3 supersample per output pixel.
function samples(px, py) {
  const s = [];
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      s.push([px + (dx + 0.5) / 3 - 0.5, py + (dy + 0.5) / 3 - 0.5]);
    }
  }
  return s;
}

function inRoundedSquare(x, y) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return false;
  if (x >= CORNER_RADIUS && x < SIZE - CORNER_RADIUS) return true;
  if (y >= CORNER_RADIUS && y < SIZE - CORNER_RADIUS) return true;
  // Corner regions: clamp to nearest corner center, check distance
  const ccX = x < CORNER_RADIUS ? CORNER_RADIUS : SIZE - 1 - CORNER_RADIUS;
  const ccY = y < CORNER_RADIUS ? CORNER_RADIUS : SIZE - 1 - CORNER_RADIUS;
  const dx = x - ccX, dy = y - ccY;
  return (dx * dx + dy * dy) <= CORNER_RADIUS * CORNER_RADIUS;
}

// Returns true if (x, y) is inside the sync glyph (circular arrow + 2 arrowheads).
function inGlyph(x, y) {
  const dx = x - cx, dy = y - cy;
  const r = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);             // -PI..PI; 0 = right, PI/2 = down

  // Ring: r in [RING_INNER, RING_OUTER], minus two gaps at 0 and PI (left + right horizontal).
  if (r >= RING_INNER && r <= RING_OUTER) {
    // angle near 0 (right) -> gap. angle near PI or -PI (left) -> gap.
    const distFromRight = Math.abs(angle);
    const distFromLeft = Math.min(Math.abs(angle - Math.PI), Math.abs(angle + Math.PI));
    if (distFromRight > GAP_ANGLE_HALF && distFromLeft > GAP_ANGLE_HALF) return true;
  }

  // Arrowheads at the gaps.
  // Right gap: triangle pointing DOWN (arrow flowing clockwise from top).
  // Apex at (cx + ((RING_INNER+RING_OUTER)/2), cy + 90); base across the gap radially.
  const ARROW_TIP = (RING_INNER + RING_OUTER) / 2;
  // Right arrow: tip at (cx + ARROW_TIP, cy + 90); base spans r=RING_INNER-30..RING_OUTER+30 along axis x=cx+ARROW_TIP-... hmm.
  // Easier: draw the arrowhead as a triangle.
  // Right-side: triangle with tip pointing DOWN at the right gap (angle 0).
  if (inTriangle(x, y,
        cx + ARROW_TIP - 95, cy,                  // top corner (inner edge)
        cx + ARROW_TIP + 95, cy,                  // top corner (outer edge)
        cx + ARROW_TIP, cy + 130)) return true;   // tip pointing down
  // Left-side: triangle with tip pointing UP at the left gap (angle PI).
  if (inTriangle(x, y,
        cx - ARROW_TIP + 95, cy,                  // top corner (inner edge)
        cx - ARROW_TIP - 95, cy,                  // top corner (outer edge)
        cx - ARROW_TIP, cy - 130)) return true;   // tip pointing up

  return false;
}

function inTriangle(px, py, ax, ay, bx, by, cxx, cyy) {
  const sign = (x1, y1, x2, y2, x3, y3) =>
    (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cxx, cyy);
  const d3 = sign(px, py, cxx, cyy, ax, ay);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

function renderPixel(x, y) {
  // 3x3 supersample
  const sample = samples(x, y);
  let inBg = 0, inGl = 0;
  for (const [sx, sy] of sample) {
    if (inRoundedSquare(sx, sy)) inBg++;
    if (inGlyph(sx, sy)) inGl++;
  }
  const total = sample.length;
  const bgAlpha = inBg / total;
  const glAlpha = inGl / total;

  if (bgAlpha === 0) return { r: 0, g: 0, b: 0, a: 0 };

  // Blend glyph (white) over background (indigo), then composite over transparent.
  const baseAlpha = Math.round(bgAlpha * 255);
  const r = Math.round((1 - glAlpha) * BG.r + glAlpha * FG.r);
  const g = Math.round((1 - glAlpha) * BG.g + glAlpha * FG.g);
  const b = Math.round((1 - glAlpha) * BG.b + glAlpha * FG.b);
  return { r, g, b, a: baseAlpha };
}

const png = new PNG({ width: SIZE, height: SIZE });
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const { r, g, b, a } = renderPixel(x, y);
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  if (y % 128 === 0) process.stdout.write(`row ${y}/${SIZE}\r`);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon-1024.png');
const stream = fs.createWriteStream(outPath);
png.pack().pipe(stream);
stream.on('finish', () => {
  const stats = fs.statSync(outPath);
  console.log(`\nwrote ${outPath} (${stats.size.toLocaleString()} bytes)`);
});