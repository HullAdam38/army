'use strict';

/**
 * Avatar badges: a badge is built from sections (shape, field colour,
 * pattern, emblem, trim, banner, honours). Each section stores the id of one
 * part, so a saved badge is a small JSON object with no free text. Some
 * parts unlock with level or with titles (src/titles.js).
 *
 * renderBadge() turns a badge into an SVG document. Every value in it comes
 * from the tables below or from escaped game data (rank grade, level, unit
 * tag, callsign), so the SVG is safe to serve.
 */

const game = require('./game');

const COLORS = [
  { id: 'olive', name: 'Olive', hex: '#556b2f' },
  { id: 'forest', name: 'Forest', hex: '#24452f' },
  { id: 'desert', name: 'Desert', hex: '#b59a62' },
  { id: 'navy', name: 'Navy', hex: '#1d2c4f' },
  { id: 'steel', name: 'Steel', hex: '#5b6b7a' },
  { id: 'black', name: 'Black', hex: '#15181b' },
  { id: 'crimson', name: 'Crimson', hex: '#8c1d24' },
  { id: 'rust', name: 'Rust', hex: '#a2521f' },
  { id: 'sky', name: 'Sky', hex: '#3d7cc0' },
  { id: 'arctic', name: 'Arctic', hex: '#e6eaee' },
  { id: 'bronze', name: 'Bronze', hex: '#b0793e', unlock: { level: 5 } },
  { id: 'silver', name: 'Silver', hex: '#c9ced4', unlock: { level: 15 } },
  { id: 'gold', name: 'Gold', hex: '#e2b23c', unlock: { level: 30 } },
  { id: 'elite', name: 'Elite violet', hex: '#b28cff', unlock: { title: 'contender' } },
];
const COLOR = new Map(COLORS.map((c) => [c.id, c]));

// Star-shaped outline: `points` tips between radius r1 and r2 around (cx, cy).
function starPoints(cx, cy, points, r1, r2, rotate = -90) {
  const out = [];
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 ? r2 : r1;
    const a = ((rotate + (180 / points) * i) * Math.PI) / 180;
    out.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return out.join(' ');
}
const polyPath = (points) => `M${points.split(' ').join('L')}Z`;

const SHAPES = [
  { id: 'shield', name: 'Shield', d: 'M60 6L106 20V58C106 86 86 104 60 114C34 104 14 86 14 58V20Z' },
  { id: 'round', name: 'Roundel', d: 'M60 7A53 53 0 1 1 60 113A53 53 0 1 1 60 7Z' },
  { id: 'patch', name: 'Patch', d: 'M22 10H98Q110 10 110 22V98Q110 110 98 110H22Q10 110 10 98V22Q10 10 22 10Z' },
  { id: 'hex', name: 'Hexagon', d: 'M60 6L107 33V87L60 114L13 87V33Z' },
  { id: 'crest', name: 'Crest', d: 'M60 6L110 42L92 112H28L10 42Z', unlock: { level: 5 } },
  { id: 'octagon', name: 'Octagon', d: polyPath(starPoints(60, 60, 4, 54, 54, -67.5)), unlock: { level: 15 } },
  { id: 'rosette', name: 'Rosette', d: polyPath(starPoints(60, 60, 12, 55, 47)), unlock: { level: 40 } },
];

// Patterns sit on top of the field, in the pattern colour, clipped to the shape.
const PATTERNS = [
  { id: 'none', name: 'Plain', svg: () => '' },
  { id: 'split', name: 'Split', svg: (c) => `<rect x="60" y="0" width="60" height="120" fill="${c}"/>` },
  { id: 'chief', name: 'Chief', svg: (c) => `<rect x="0" y="0" width="120" height="34" fill="${c}"/>` },
  { id: 'band', name: 'Diagonal', svg: (c) => `<polygon points="0,18 18,0 120,102 102,120" fill="${c}"/>` },
  { id: 'chevron', name: 'Chevron', svg: (c) => `<polygon points="0,64 60,94 120,64 120,82 60,112 0,82" fill="${c}"/>` },
  { id: 'stripes', name: 'Stripes', svg: (c) => [16, 44, 72, 100].map((x) => `<rect x="${x - 6}" y="0" width="12" height="120" fill="${c}"/>`).join('') },
  { id: 'quartered', name: 'Quartered', svg: (c) => `<rect x="0" y="0" width="60" height="60" fill="${c}"/><rect x="60" y="60" width="60" height="60" fill="${c}"/>` },
  {
    id: 'camo', name: 'Woodland camo', unlock: { level: 10 },
    svg: (c) => ['M8 20C20 8 34 14 40 24S30 44 18 40 0 30 8 20Z', 'M70 6C84 2 96 10 92 22S74 30 66 22 62 9 70 6Z', 'M86 52C100 46 116 56 112 70S92 80 84 70 76 57 86 52Z',
      'M24 72C36 64 50 72 48 84S30 98 22 92 14 78 24 72Z', 'M52 40C60 34 72 40 70 50S56 60 50 54 46 44 52 40Z', 'M60 96C72 92 82 100 78 110S62 118 56 110 52 99 60 96Z']
      .map((d) => `<path d="${d}" fill="${c}"/>`).join(''),
  },
  {
    id: 'sunburst', name: 'Sunburst', unlock: { level: 25 },
    svg: (c) => Array.from({ length: 12 }, (_, i) => {
      const a = (i * 30 * Math.PI) / 180;
      const b = ((i * 30 + 15) * Math.PI) / 180;
      const p = (t) => `${(60 + 90 * Math.cos(t)).toFixed(1)},${(60 + 90 * Math.sin(t)).toFixed(1)}`;
      return `<polygon points="60,60 ${p(a)} ${p(b)}" fill="${c}"/>`;
    }).join(''),
  },
  {
    id: 'digital', name: 'Digital camo', unlock: { level: 40 },
    // A fixed scatter of squares, so every digital badge looks the same.
    svg: (c) => {
      let seed = 7;
      const next = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      const cells = [];
      for (let y = 0; y < 120; y += 10) for (let x = 0; x < 120; x += 10) if (next() < 0.36) cells.push(`<rect x="${x}" y="${y}" width="10" height="10" fill="${c}"/>`);
      return cells.join('');
    },
  },
];

// Emblems are drawn around (60, 54) in a roughly 52 × 56 box.
const EMBLEMS = [
  { id: 'star', name: 'Star', svg: (c) => `<polygon points="${starPoints(60, 55, 5, 27, 11)}" fill="${c}"/>` },
  { id: 'chevrons', name: 'Chevrons', svg: (c) => `<path d="M36 30L60 46L84 30V42L60 58L36 42Z M36 52L60 68L84 52V64L60 80L36 64Z" fill="${c}"/>` },
  { id: 'bolt', name: 'Lightning', svg: (c) => `<polygon points="67,24 42,60 57,60 50,86 78,46 63,46 72,24" fill="${c}"/>` },
  {
    id: 'crosshair', name: 'Crosshair',
    svg: (c) => `<g fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round"><circle cx="60" cy="55" r="18"/><path d="M60 27V43M60 67V83M32 55H48M72 55H88"/></g><circle cx="60" cy="55" r="4" fill="${c}"/>`,
  },
  {
    id: 'swords', name: 'Crossed swords',
    svg: (c) => `<g stroke="${c}" stroke-width="5" stroke-linecap="round"><path d="M40 28L78 80M80 28L42 80"/><path d="M64 74L76 64M44 64L56 74" stroke-width="6"/></g>`,
  },
  {
    id: 'dagger', name: 'Dagger',
    svg: (c) => `<path d="M60 22L67 60H53Z" fill="${c}"/><rect x="46" y="60" width="28" height="6" rx="3" fill="${c}"/><rect x="56.5" y="66" width="7" height="14" fill="${c}"/><circle cx="60" cy="84" r="4.5" fill="${c}"/>`,
  },
  {
    id: 'anchor', name: 'Anchor',
    svg: (c) => `<g fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round"><circle cx="60" cy="29" r="5"/><path d="M60 34V82M48 44H72M36 64Q38 82 60 82Q82 82 84 64"/></g>`,
  },
  {
    id: 'parachute', name: 'Parachute',
    svg: (c) => `<path d="M30 50Q30 25 60 25Q90 25 90 50Q83 44 75 50Q67 44 60 50Q53 44 45 50Q37 44 30 50Z" fill="${c}"/><path d="M31 50L58 76M45 50L59 76M75 50L61 76M89 50L62 76" stroke="${c}" stroke-width="2"/><rect x="55" y="75" width="10" height="9" rx="2" fill="${c}"/>`,
  },
  {
    id: 'wings', name: 'Wings', unlock: { level: 10 },
    svg: (c) => {
      const wing = 'M54 52C44 40 28 38 14 42C24 46 30 49 34 53C26 53 20 56 16 61C27 62 36 62 42 61C38 64 34 67 31 71C42 70 50 66 55 60Z';
      return `<path d="${wing}" fill="${c}"/><path d="${wing}" fill="${c}" transform="translate(120 0) scale(-1 1)"/><circle cx="60" cy="56" r="8" fill="${c}"/>`;
    },
  },
  {
    id: 'flame', name: 'Flame', unlock: { level: 20 },
    svg: (c) => `<path d="M60 22C67 37 81 43 79 62C78 75 70 84 60 84C50 84 41 76 41 64C40 52 50 46 52 35C56 41 57 47 60 50C64 42 63 31 60 22Z" fill="${c}"/>`,
  },
  {
    id: 'skull', name: 'Skull', unlock: { title: 'enforcer' },
    svg: (c) => `<path fill-rule="evenodd" fill="${c}" d="M60 26C43 26 35 38 35 51C35 60 39 65 46 68V80H74V68C81 65 85 60 85 51C85 38 77 26 60 26Z M47 49A6.5 6.5 0 1 0 60 49A6.5 6.5 0 1 0 47 49Z M60 49A6.5 6.5 0 1 0 73 49A6.5 6.5 0 1 0 60 49Z M60 58L55.5 65H64.5Z M53 72H55V80H53Z M59 72H61V80H59Z M65 72H67V80H65Z"/>`,
  },
  {
    id: 'globe', name: 'Globe', unlock: { level: 35 },
    svg: (c) => `<g fill="none" stroke="${c}" stroke-width="4"><circle cx="60" cy="55" r="25"/><ellipse cx="60" cy="55" rx="11" ry="25"/><path d="M35 55H85M39 42H81M39 68H81"/></g>`,
  },
  {
    id: 'crown', name: 'Crown', unlock: { title: 'legend' },
    svg: (c) => `<path d="M34 72L29 36L46 51L60 30L74 51L91 36L86 72Z" fill="${c}"/><rect x="34" y="75" width="52" height="7" rx="2" fill="${c}"/><circle cx="29" cy="34" r="3.5" fill="${c}"/><circle cx="60" cy="28" r="3.5" fill="${c}"/><circle cx="91" cy="34" r="3.5" fill="${c}"/>`,
  },
];

const TRIMS = [
  { id: 'none', name: 'None' },
  { id: 'line', name: 'Line', width: 4 },
  { id: 'heavy', name: 'Heavy', width: 8 },
  { id: 'double', name: 'Double', width: 3, inner: true },
  { id: 'rivets', name: 'Riveted', width: 5, dash: '0.1 9', unlock: { level: 8 } },
];

const BANNERS = [
  { id: 'none', name: 'No banner' },
  { id: 'grade', name: 'Rank grade' },
  { id: 'level', name: 'Level' },
  { id: 'callsign', name: 'Callsign' },
  { id: 'unit', name: 'Unit tag' },
];

const HONOURS = [
  { id: 'none', name: 'None' },
  { id: 'star1', name: 'One star', stars: 1, unlock: { level: 10 } },
  { id: 'star2', name: 'Two stars', stars: 2, unlock: { level: 25 } },
  { id: 'star3', name: 'Three stars', stars: 3, unlock: { level: 50 } },
  { id: 'laurel', name: 'Laurel wreath', unlock: { title: 'veteran' } },
];

/** The sections of the builder, in the order the page shows them. */
const SECTIONS = [
  { key: 'shape', name: 'Shape', parts: SHAPES },
  { key: 'field', name: 'Field colour', parts: COLORS },
  { key: 'pattern', name: 'Pattern', parts: PATTERNS },
  { key: 'patternColor', name: 'Pattern colour', parts: COLORS },
  { key: 'emblem', name: 'Emblem', parts: EMBLEMS },
  { key: 'emblemColor', name: 'Emblem colour', parts: COLORS },
  { key: 'trim', name: 'Trim', parts: TRIMS },
  { key: 'trimColor', name: 'Trim colour', parts: COLORS },
  { key: 'banner', name: 'Banner', parts: BANNERS },
  { key: 'honours', name: 'Honours', parts: HONOURS },
];
const SECTION = new Map(SECTIONS.map((s) => [s.key, { ...s, byId: new Map(s.parts.map((p) => [p.id, p])) }]));

const DEFAULT_BADGE = Object.freeze({
  shape: 'shield', field: 'olive', pattern: 'none', patternColor: 'black', emblem: 'star', emblemColor: 'desert',
  trim: 'line', trimColor: 'desert', banner: 'grade', honours: 'none',
});

/** A varied starting badge for players who haven't made one, picked from their id. */
function defaultBadge(userId) {
  const n = Math.abs(Number(userId) || 0);
  const pick = (list, salt) => list[(n * 7 + salt * 13 + Math.floor(n / list.length)) % list.length];
  const field = pick(['olive', 'forest', 'navy', 'steel', 'black', 'crimson', 'rust', 'sky'], 1);
  return {
    ...DEFAULT_BADGE,
    shape: pick(['shield', 'round', 'patch', 'hex'], 2),
    field,
    emblem: pick(['star', 'chevrons', 'bolt', 'crosshair', 'swords', 'dagger', 'anchor', 'parachute'], 3),
    emblemColor: field === 'sky' || field === 'steel' ? 'arctic' : 'desert',
  };
}

/** How a part unlocks, in words, or null if it's open to everyone. */
function unlockText(part) {
  if (!part.unlock) return null;
  if (part.unlock.level) return `Reach level ${part.unlock.level}`;
  const titles = require('./titles');
  const t = titles.TITLES_BY_ID.get(part.unlock.title);
  return t ? `Earn the “${t.name}” title` : 'Locked';
}

/** Whether a player with this level and these earned title ids may use `part`. */
function isUnlocked(part, { level = 1, titles = new Set() } = {}) {
  if (!part.unlock) return true;
  if (part.unlock.level) return level >= part.unlock.level;
  return titles.has(part.unlock.title);
}

/**
 * Cleans a badge from a form or the database. Unknown sections are dropped
 * and unknown parts fall back to `base`. With `owner`, parts the owner hasn't
 * unlocked are refused and listed in `locked`.
 */
function normalize(input, { base = DEFAULT_BADGE, owner = null } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const badge = {};
  const locked = [];
  for (const [key, section] of SECTION) {
    const id = typeof src[key] === 'string' ? src[key] : null;
    const part = id && section.byId.get(id);
    if (part && owner && !isUnlocked(part, owner)) locked.push(`${section.name}: ${part.name}`);
    badge[key] = part && (!owner || isUnlocked(part, owner)) ? part.id : (section.byId.has(base[key]) ? base[key] : DEFAULT_BADGE[key]);
  }
  return { badge, locked };
}

/** Reads a badge saved as JSON; anything broken falls back to the default. */
function parseBadge(json, userId) {
  const base = defaultBadge(userId);
  if (!json) return base;
  try {
    return normalize(JSON.parse(json), { base }).badge;
  } catch {
    return base;
  }
}

const escapeXml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// Dark text on light colours, light text on dark ones.
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 140 ? '#15181b' : '#f2f4f5';
}

/** The text a banner shows for a player, or '' for none. */
function bannerText(kind, { level = 1, username = '', unitTag = '' } = {}) {
  if (kind === 'grade') return game.rankFor(level).grade;
  if (kind === 'level') return `LV ${level}`;
  if (kind === 'callsign') return String(username).toUpperCase().slice(0, 12);
  if (kind === 'unit') return unitTag ? `[${unitTag}]` : '';
  return '';
}

function laurel(color) {
  const leaves = [];
  for (let i = 0; i < 7; i += 1) {
    const deg = 112 + i * 21; // down the left side, from the bottom up
    const a = (deg * Math.PI) / 180;
    const x = (60 + 38 * Math.cos(a)).toFixed(1);
    const y = (58 + 35 * Math.sin(a)).toFixed(1);
    leaves.push(`<ellipse cx="${x}" cy="${y}" rx="8" ry="3.6" transform="rotate(${deg + 90 - 25} ${x} ${y})"/>`);
  }
  const side = leaves.join('');
  return `<g fill="${color}">${side}<g transform="translate(120 0) scale(-1 1)">${side}</g></g>`;
}

/**
 * The badge as an SVG document. `who` supplies the banner text: { level,
 * username, unitTag }. `size` sets the width and height attributes.
 */
function renderBadge(badgeInput, who = {}, { size = 120 } = {}) {
  const { badge } = normalize(badgeInput);
  const part = (key) => SECTION.get(key).byId.get(badge[key]);
  const hex = (key) => COLOR.get(badge[key]).hex;
  const shape = part('shape');
  const trim = part('trim');
  const honours = part('honours');
  const text = bannerText(badge.banner, who);
  const hasBanner = Boolean(text);
  const hasStars = Boolean(honours.stars);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">`);
  out.push(`<defs><clipPath id="s"><path d="${shape.d}"/></clipPath></defs>`);
  out.push(`<path d="${shape.d}" fill="${hex('field')}"/>`);
  const pattern = part('pattern').svg(hex('patternColor'));
  if (pattern) out.push(`<g clip-path="url(#s)">${pattern}</g>`);
  // A soft shine across the top keeps flat colours from looking dull.
  out.push(`<g clip-path="url(#s)"><rect x="0" y="0" width="120" height="58" fill="#fff" opacity="0.07"/></g>`);

  // The emblem shrinks to make room for stars above or a banner below.
  const scale = hasBanner && hasStars ? 0.7 : hasBanner || hasStars ? 0.8 : 0.95;
  const cy = hasStars && !hasBanner ? 60 : hasBanner && !hasStars ? 50 : 55;
  const emblemColor = hex('emblemColor');
  out.push(`<g transform="translate(60 ${cy}) scale(${scale}) translate(-60 -55)">`);
  out.push(part('emblem').svg(emblemColor, hex('field')));
  if (honours.id === 'laurel') out.push(laurel(emblemColor));
  out.push('</g>');

  if (hasStars) {
    const xs = { 1: [60], 2: [52, 68], 3: [44, 60, 76] }[honours.stars];
    for (const x of xs) out.push(`<polygon points="${starPoints(x, 23, 5, 6, 2.5)}" fill="${emblemColor}"/>`);
  }

  if (trim.width) {
    const attrs = `fill="none" stroke="${hex('trimColor')}" stroke-width="${trim.width}" stroke-linejoin="round"${trim.dash ? ` stroke-dasharray="${trim.dash}" stroke-linecap="round"` : ''}`;
    out.push(`<path d="${shape.d}" ${attrs}/>`);
    if (trim.inner) out.push(`<path d="${shape.d}" ${attrs} stroke-width="2" transform="translate(60 60) scale(0.86) translate(-60 -60)"/>`);
  }

  if (hasBanner) {
    const ribbon = trim.width ? hex('trimColor') : '#15181b';
    out.push(`<path d="M14 84H106L99 95L106 106H14L21 95Z" fill="${ribbon}" stroke="#000" stroke-opacity="0.25" stroke-width="1"/>`);
    const fit = text.length > 7 ? ` textLength="${Math.min(78, text.length * 9)}" lengthAdjust="spacingAndGlyphs"` : '';
    out.push(`<text x="60" y="100" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="14" letter-spacing="0.5" fill="${inkFor(ribbon)}"${fit}>${escapeXml(text)}</text>`);
  }
  out.push('</svg>');
  return out.join('');
}

/** A small picture of one part on its own, for the builder's option buttons. */
function renderPartSample(sectionKey, partId) {
  const section = SECTION.get(sectionKey);
  const p = section && section.byId.get(partId);
  if (!p) return '';
  const wrap = (inner) => `<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">${inner}</svg>`;
  if (sectionKey === 'shape') return wrap(`<path d="${p.d}" fill="currentColor" opacity="0.85"/>`);
  if (sectionKey === 'pattern') return wrap(`<defs><clipPath id="ps-${p.id}"><path d="${SHAPES[2].d}"/></clipPath></defs><path d="${SHAPES[2].d}" fill="#3a4148"/><g clip-path="url(#ps-${p.id})">${p.svg('#9aa5ae')}</g>`);
  if (sectionKey === 'emblem') return wrap(p.svg('currentColor', '#1b1f23'));
  if (sectionKey === 'trim') return p.width ? wrap(`<path d="${SHAPES[0].d}" fill="none" stroke="currentColor" stroke-width="${p.width + 2}" stroke-linejoin="round"${p.dash ? ` stroke-dasharray="0.1 11" stroke-linecap="round"` : ''}/>${p.inner ? `<path d="${SHAPES[0].d}" fill="none" stroke="currentColor" stroke-width="3" transform="translate(60 60) scale(0.84) translate(-60 -60)"/>` : ''}`) : wrap('<path d="M30 90L90 30" stroke="currentColor" stroke-width="6" opacity="0.5"/>');
  if (sectionKey === 'honours') {
    if (p.id === 'laurel') return wrap(laurel('currentColor'));
    if (!p.stars) return wrap('<path d="M30 90L90 30" stroke="currentColor" stroke-width="6" opacity="0.5"/>');
    const xs = { 1: [60], 2: [40, 80], 3: [22, 60, 98] }[p.stars];
    return wrap(xs.map((x) => `<polygon points="${starPoints(x, 60, 5, 17, 7)}" fill="currentColor"/>`).join(''));
  }
  return '';
}

module.exports = {
  BANNERS,
  COLORS,
  DEFAULT_BADGE,
  EMBLEMS,
  HONOURS,
  PATTERNS,
  SECTIONS,
  SHAPES,
  TRIMS,
  bannerText,
  defaultBadge,
  isUnlocked,
  normalize,
  parseBadge,
  renderBadge,
  renderPartSample,
  unlockText,
};
