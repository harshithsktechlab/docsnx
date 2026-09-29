/**
 * Generate the four landing feature-card images as vector art, rasterised to WebP.
 *
 * Text-free by construction — no baked-in headlines, no AI-garbled wordmarks.
 * Palette is taken from src/app/globals.css:
 *   --card (dark)  240 10% 6%   -> #0E0E11
 *   --primary      258 90% 66%  -> #8B5CF6
 *
 * Output: public/assets/landing/cards/{vault,ai-insights,devices,drive}.webp
 * Rendered at 1800x1200 and downsampled to 900x600 for clean edges.
 *
 * Usage: node scripts/build-card-art.mjs
 */
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const W = 900;
const H = 600;
const SUPERSAMPLE = 2;

const BG = '#0E0E11';
const VIOLET = '#8B5CF6';

/** Shared defs: background wash, glass fills, violet edge gradient, glow filters. */
const defs = `
  <radialGradient id="bg" cx="50%" cy="42%" r="70%">
    <stop offset="0%"   stop-color="#251845"/>
    <stop offset="55%"  stop-color="#15111F"/>
    <stop offset="100%" stop-color="${BG}"/>
  </radialGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="0.3" y2="1">
    <stop offset="0%"   stop-color="#4A4363" stop-opacity="0.85"/>
    <stop offset="55%"  stop-color="#221E33" stop-opacity="0.9"/>
    <stop offset="100%" stop-color="#141220" stop-opacity="0.95"/>
  </linearGradient>
  <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%"   stop-color="#DDD6FE"/>
    <stop offset="45%"  stop-color="${VIOLET}"/>
    <stop offset="100%" stop-color="#4C1D95"/>
  </linearGradient>
  <linearGradient id="screen" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0%"   stop-color="#A78BFA" stop-opacity="0.55"/>
    <stop offset="60%"  stop-color="${VIOLET}" stop-opacity="0.28"/>
    <stop offset="100%" stop-color="#312E81" stop-opacity="0.18"/>
  </linearGradient>
  <filter id="glow" x="-70%" y="-70%" width="240%" height="240%">
    <feGaussianBlur stdDeviation="9" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="haze" x="-90%" y="-90%" width="280%" height="280%">
    <feGaussianBlur stdDeviation="42"/>
  </filter>
  <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="4"/>
  </filter>
`;

/** Perspective floor grid — ties all four images into one set. */
const floor = (y0 = 430) => {
  const rows = Array.from({ length: 7 }, (_, i) => {
    const y = y0 + i * i * 6.5;
    return y < H ? `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>` : '';
  }).join('');
  const cols = Array.from({ length: 13 }, (_, i) => {
    const x = 450 + (i - 6) * 46;
    const xEnd = 450 + (i - 6) * 210;
    return `<line x1="${x}" y1="${y0}" x2="${xEnd}" y2="${H}"/>`;
  }).join('');
  return `<g stroke="${VIOLET}" stroke-opacity="0.10" stroke-width="1.1">${rows}${cols}</g>`;
};

const frame = (body, glowCx = 450, glowCy = 290) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${defs}</defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${floor()}
  <ellipse cx="${glowCx}" cy="${glowCy}" rx="185" ry="150" fill="${VIOLET}" opacity="0.30" filter="url(#haze)"/>
  ${body}
</svg>`;

// ── 1. Zero-Knowledge Vault ──────────────────────────────────────────────────
// Vault door: concentric dial, glowing seam, four-spoke handle, perimeter bolts.
const vault = (() => {
  const cx = 450, cy = 288;
  const bolts = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    const r = 156;
    return `<circle cx="${(cx + Math.cos(a) * r).toFixed(1)}" cy="${(cy + Math.sin(a) * r).toFixed(1)}" r="5.5" fill="#2C2740" stroke="${VIOLET}" stroke-opacity="0.55" stroke-width="1.5"/>`;
  }).join('');
  const spokes = [0, 90, 180, 270].map((d) =>
    `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 92}" transform="rotate(${d} ${cx} ${cy})"/>`
  ).join('');
  return frame(`
    <ellipse cx="${cx}" cy="472" rx="176" ry="26" fill="#000" opacity="0.5" filter="url(#soft)"/>
    <circle cx="${cx}" cy="${cy}" r="176" fill="url(#glass)" stroke="${VIOLET}" stroke-opacity="0.28" stroke-width="2"/>
    ${bolts}
    <circle cx="${cx}" cy="${cy}" r="140" fill="none" stroke="url(#edge)" stroke-width="4" filter="url(#glow)"/>
    <circle cx="${cx}" cy="${cy}" r="112" fill="none" stroke="${VIOLET}" stroke-opacity="0.30" stroke-width="1.6"/>
    <circle cx="${cx}" cy="${cy}" r="84"  fill="url(#glass)" stroke="${VIOLET}" stroke-opacity="0.42" stroke-width="2"/>
    <g stroke="url(#edge)" stroke-width="9" stroke-linecap="round" filter="url(#glow)">${spokes}</g>
    <circle cx="${cx}" cy="${cy}" r="30" fill="#1A1626" stroke="url(#edge)" stroke-width="3.5" filter="url(#glow)"/>
    <circle cx="${cx}" cy="${cy}" r="11" fill="${VIOLET}" filter="url(#glow)"/>
    <path d="M ${cx - 162} ${cy - 62} A 176 176 0 0 1 ${cx - 62} ${cy - 162}" fill="none" stroke="#EDE9FE" stroke-opacity="0.28" stroke-width="3" stroke-linecap="round"/>
  `);
})();

// ── 2. AI-Powered Insights ───────────────────────────────────────────────────
// Glass prism refracting a rising curve into light rays; unlabelled data nodes.
const ai = (() => {
  const pts = [[268, 396], [340, 356], [412, 372], [484, 300], [556, 262], [628, 196]];
  const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' ');
  const nodes = pts.map(([x, y], i) =>
    `<circle cx="${x}" cy="${y}" r="${i === pts.length - 1 ? 11 : 7}" fill="${i === pts.length - 1 ? '#EDE9FE' : '#C4B5FD'}" filter="url(#glow)"/>`
  ).join('');
  // Rays stop well inside the frame — trailing off the canvas edge reads as a glitch.
  const rays = [-14, -2, 10].map((d, i) =>
    `<line x1="472" y1="318" x2="${690 - i * 14}" y2="${268 + d * 6}" stroke="url(#edge)" stroke-opacity="${0.42 - i * 0.10}" stroke-width="${3.2 - i * 0.6}" stroke-linecap="round" filter="url(#glow)"/>`
  ).join('');
  return frame(`
    <ellipse cx="450" cy="470" rx="196" ry="24" fill="#000" opacity="0.45" filter="url(#soft)"/>
    ${rays}
    <path d="M 300 400 L 452 152 L 604 400 Z" fill="url(#glass)" stroke="url(#edge)" stroke-width="3.5" stroke-linejoin="round" filter="url(#glow)"/>
    <path d="M 300 400 L 452 152 L 452 400 Z" fill="#A78BFA" opacity="0.10"/>
    <path d="${line}" fill="none" stroke="url(#edge)" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
    ${nodes}
    <circle cx="214" cy="248" r="5" fill="${VIOLET}" opacity="0.65" filter="url(#glow)"/>
    <circle cx="700" cy="404" r="4" fill="${VIOLET}" opacity="0.5" filter="url(#glow)"/>
    <circle cx="662" cy="128" r="6" fill="#C4B5FD" opacity="0.55" filter="url(#glow)"/>
  `);
})();

// ── 3. Works on Every Device ─────────────────────────────────────────────────
// Phone / laptop / tablet in an arc. Screens are pure gradient — no readable UI.
const devices = (() => {
  const screenBars = (x, y, w, gap, n, wid) =>
    Array.from({ length: n }, (_, i) =>
      `<rect x="${x}" y="${y + i * gap}" width="${wid(i)}" height="${gap * 0.34}" rx="${gap * 0.17}" fill="#C4B5FD" opacity="${0.30 - i * 0.045}"/>`
    ).join('');
  return frame(`
    <ellipse cx="450" cy="474" rx="250" ry="26" fill="#000" opacity="0.5" filter="url(#soft)"/>

    <!-- laptop -->
    <rect x="306" y="176" width="288" height="196" rx="14" fill="url(#glass)" stroke="url(#edge)" stroke-width="3" filter="url(#glow)"/>
    <rect x="320" y="190" width="260" height="168" rx="8" fill="url(#screen)"/>
    ${screenBars(342, 216, 0, 26, 4, (i) => 210 - i * 34)}
    <path d="M 272 372 L 628 372 L 646 400 L 254 400 Z" fill="url(#glass)" stroke="url(#edge)" stroke-width="2.5"/>
    <rect x="414" y="378" width="72" height="7" rx="3.5" fill="#C4B5FD" opacity="0.35"/>

    <!-- phone (left) -->
    <rect x="150" y="228" width="112" height="200" rx="20" fill="url(#glass)" stroke="url(#edge)" stroke-width="3" filter="url(#glow)"/>
    <rect x="160" y="244" width="92" height="168" rx="12" fill="url(#screen)"/>
    ${screenBars(172, 264, 0, 22, 4, (i) => 68 - i * 11)}
    <rect x="188" y="234" width="36" height="5" rx="2.5" fill="#C4B5FD" opacity="0.4"/>

    <!-- tablet (right) -->
    <rect x="638" y="212" width="150" height="216" rx="16" fill="url(#glass)" stroke="url(#edge)" stroke-width="3" filter="url(#glow)"/>
    <rect x="650" y="226" width="126" height="188" rx="10" fill="url(#screen)"/>
    ${screenBars(664, 250, 0, 24, 5, (i) => 98 - i * 15)}
  `);
})();

// ── 4. Your Google Drive ─────────────────────────────────────────────────────
// Generic cloud + folder + orbiting sync arc + sealed locks.
// Deliberately NO Google mark or Drive triangle — trademark-safe.
const drive = (() => {
  const cloud = `
    M 296 320
    a 66 66 0 0 1 12 -130
    a 92 92 0 0 1 172 -26
    a 74 74 0 0 1 118 62
    a 60 60 0 0 1 -14 94
    Z`;
  const lock = (x, y, s) => `
    <g transform="translate(${x} ${y}) scale(${s})" filter="url(#glow)">
      <path d="M -13 -6 a 13 13 0 0 1 26 0 v 6 h -6 v -6 a 7 7 0 0 0 -14 0 v 6 h -6 Z" fill="#C4B5FD"/>
      <rect x="-17" y="-2" width="34" height="27" rx="6" fill="url(#glass)" stroke="url(#edge)" stroke-width="2.5"/>
      <circle cx="0" cy="11" r="4" fill="${VIOLET}"/>
    </g>`;
  return frame(`
    <ellipse cx="450" cy="474" rx="200" ry="24" fill="#000" opacity="0.45" filter="url(#soft)"/>

    <!-- orbiting sync arc -->
    <ellipse cx="450" cy="322" rx="278" ry="104" fill="none" stroke="${VIOLET}" stroke-opacity="0.22" stroke-width="2" stroke-dasharray="14 12"/>
    <path d="M 172 322 a 278 104 0 0 1 278 -104" fill="none" stroke="url(#edge)" stroke-width="4" stroke-linecap="round" filter="url(#glow)"/>
    <path d="M 728 322 a 278 104 0 0 1 -278 104" fill="none" stroke="url(#edge)" stroke-width="4" stroke-linecap="round" filter="url(#glow)"/>
    <path d="M 438 205 l 16 13 l -16 13 Z" fill="#EDE9FE" filter="url(#glow)"/>
    <path d="M 462 439 l -16 -13 l 16 -13 Z" fill="#EDE9FE" filter="url(#glow)"/>

    <!-- cloud -->
    <path d="${cloud}" fill="url(#glass)" stroke="url(#edge)" stroke-width="3.5" stroke-linejoin="round" filter="url(#glow)"/>

    <!-- folder emerging -->
    <path d="M 366 300 h 66 l 20 24 h 82 a 14 14 0 0 1 14 14 v 78 a 14 14 0 0 1 -14 14 H 366 a 14 14 0 0 1 -14 -14 v -102 a 14 14 0 0 1 14 -14 Z"
          fill="url(#glass)" stroke="url(#edge)" stroke-width="3.5" stroke-linejoin="round" filter="url(#glow)"/>
    <path d="M 366 340 h 168" stroke="${VIOLET}" stroke-opacity="0.35" stroke-width="2"/>

    ${lock(450, 372, 1.15)}
    ${lock(268, 396, 0.72)}
    ${lock(636, 400, 0.72)}
  `, 450, 300);
})();

const ART = { vault, 'ai-insights': ai, devices, drive };

const outDir = path.join(process.cwd(), 'public/assets/landing/cards');
await mkdir(outDir, { recursive: true });

for (const [name, svg] of Object.entries(ART)) {
  const out = path.join(outDir, `${name}.webp`);
  const info = await sharp(Buffer.from(svg), { density: 96 * SUPERSAMPLE })
    .resize(W * SUPERSAMPLE, H * SUPERSAMPLE, { fit: 'fill' })
    .resize(W, H, { kernel: 'lanczos3' })
    .webp({ quality: 82 })
    .toFile(out);
  console.log(`✓ ${name.padEnd(12)} ${W}x${H}  ${(info.size / 1024).toFixed(0)} KB`);
}
