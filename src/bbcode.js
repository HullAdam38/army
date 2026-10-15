'use strict';

/**
 * A small, strict BBCode renderer for player-written text (private messages).
 *
 * Safety model: the input is never treated as HTML. It's split into BBCode tags
 * and plain text; text is always HTML-escaped; only the tags below produce
 * markup, and every attribute is validated against an allowlist (colours,
 * sizes, http(s) links). Anything unknown or malformed is shown as literal text.
 */

const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray', 'white'];
const SIZES = { small: 'bb-size-small', large: 'bb-size-large', huge: 'bb-size-huge' };
const MAX_DEPTH = 12; // nested tags
const MAX_QUOTE_DEPTH = 3;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A safe http(s) URL, or null. */
function safeUrl(raw) {
  const s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null; // no credentials in links
    return u.href;
  } catch {
    return null;
  }
}

const safeColor = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (COLORS.includes(s)) return s;
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s) ? s : null;
};

const CALLSIGN = /^[A-Za-z0-9_]{3,20}$/;

/**
 * Tag definitions. `attr(value)` validates the attribute (return undefined to
 * reject the tag); `render(inner, attr)` returns HTML for already-rendered children.
 */
const TAGS = {
  b: { render: (h) => `<strong>${h}</strong>` },
  i: { render: (h) => `<em>${h}</em>` },
  u: { render: (h) => `<span class="bb-u">${h}</span>` },
  s: { render: (h) => `<s>${h}</s>` },
  center: { block: true, render: (h) => `<div class="bb-center">${h}</div>` },
  color: { attr: (v) => safeColor(v) || undefined, render: (h, a) => `<span class="bb-color" style="color:${a}">${h}</span>` },
  size: { attr: (v) => (Object.hasOwn(SIZES, String(v).toLowerCase()) ? String(v).toLowerCase() : undefined), render: (h, a) => `<span class="${SIZES[a]}">${h}</span>` },
  quote: {
    block: true,
    attr: (v) => (v === null ? null : String(v).trim().slice(0, 30) || null),
    render: (h, a) => `<blockquote class="bb-quote">${a ? `<cite>${escapeHtml(a)} wrote:</cite>` : ''}${h}</blockquote>`,
  },
  spoiler: { block: true, render: (h) => `<details class="bb-spoiler"><summary>Spoiler</summary><div>${h}</div></details>` },
  url: {
    attr: (v) => (v === null ? null : safeUrl(v) || undefined),
    // [url]https://…[/url] uses its text as the address; checked at render time.
    render: (h, a, raw) => {
      const href = a || safeUrl(raw);
      if (!href) return h;
      return `<a href="${escapeHtml(href)}" rel="nofollow noopener noreferrer ugc" target="_blank">${h}</a>`;
    },
  },
  player: {
    render: (h, a, raw) => {
      const name = String(raw || '').trim();
      return CALLSIGN.test(name) ? `<a class="bb-player" href="/profile/${encodeURIComponent(name)}">${escapeHtml(name)}</a>` : h;
    },
  },
  list: {
    block: true,
    attr: (v) => (v === null ? null : v === '1' ? '1' : v === 'a' ? 'a' : undefined),
    render: (h, a) => (a ? `<ol class="bb-list" type="${a}">${h}</ol>` : `<ul class="bb-list">${h}</ul>`),
  },
  code: { block: true, raw: true, render: (h) => `<pre class="bb-code"><code>${h}</code></pre>` },
  hr: { void: true, block: true, render: () => '<hr class="bb-hr">' },
};

const TAG_RE = /\[(\/?)([a-z*]{1,8})(?:=([^\]\n]{1,300}))?\]/gi;

/** Splits text into tokens: { type: 'text', value } | { type: 'open', name, attr, src } | { type: 'close', name, src }. */
function tokenize(input) {
  const tokens = [];
  let last = 0;
  for (const m of input.matchAll(TAG_RE)) {
    const name = m[2].toLowerCase();
    if (name !== '*' && !Object.hasOwn(TAGS, name)) continue; // unknown: stays as text
    if (m.index > last) tokens.push({ type: 'text', value: input.slice(last, m.index) });
    tokens.push(m[1] ? { type: 'close', name, src: m[0] } : { type: 'open', name, attr: m[3] === undefined ? null : m[3], src: m[0] });
    last = m.index + m[0].length;
  }
  if (last < input.length) tokens.push({ type: 'text', value: input.slice(last) });
  return tokens;
}

/** Builds a tree from tokens, auto-closing unclosed tags and keeping stray tags as text. */
function parse(input) {
  const root = { name: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const text = (value) => top().children.push({ text: value });
  const tokens = tokenize(input);

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'text') { text(t.value); continue; }

    if (t.type === 'open') {
      if (t.name === '*') {
        // List items only inside a list; a new [*] closes the previous item.
        const listIdx = stack.map((n) => n.name).lastIndexOf('list');
        if (listIdx === -1) { text(t.src); continue; }
        stack.length = listIdx + 1;
        const item = { name: '*', children: [] };
        top().children.push(item);
        stack.push(item);
        continue;
      }
      const def = TAGS[t.name];
      const attr = def.attr ? def.attr(t.attr) : t.attr === null ? null : undefined;
      const quoteDepth = stack.filter((n) => n.name === 'quote').length;
      const inLink = stack.some((n) => n.name === 'url' || n.name === 'player');
      if (attr === undefined || stack.length > MAX_DEPTH || (t.name === 'quote' && quoteDepth >= MAX_QUOTE_DEPTH)
        || ((t.name === 'url' || t.name === 'player') && inLink)) { text(t.src); continue; }
      const node = { name: t.name, attr, children: [] };
      top().children.push(node);
      if (def.void) continue;
      if (def.raw) {
        // Everything up to the matching close tag is literal text.
        let j = i + 1;
        let raw = '';
        while (j < tokens.length && !(tokens[j].type === 'close' && tokens[j].name === t.name)) {
          raw += tokens[j].type === 'text' ? tokens[j].value : tokens[j].src;
          j += 1;
        }
        node.children.push({ text: raw });
        i = j; // skips the close tag too (or runs to the end)
        continue;
      }
      stack.push(node);
      continue;
    }

    // Close tag: close back to the nearest matching open tag, or keep as text.
    const idx = stack.map((n) => n.name).lastIndexOf(t.name);
    if (idx <= 0) { text(t.src); continue; }
    stack.length = idx;
  }
  return root;
}

const plainText = (node) => (node.text !== undefined ? node.text : node.children.map(plainText).join(''));

function renderNodes(nodes, { inList = false } = {}) {
  let html = '';
  for (const node of nodes) {
    if (node.text !== undefined) {
      // Inside a list, stray whitespace between items isn't content.
      if (inList && !node.text.trim()) continue;
      html += escapeHtml(inList ? node.text.trim() : node.text).replace(/\n/g, '<br>');
      continue;
    }
    if (node.name === '*') {
      html += `<li>${renderNodes(trimEdges(node.children))}</li>`;
      continue;
    }
    const def = TAGS[node.name];
    if (def.void) { html += def.render(); continue; }
    const children = def.block ? trimEdges(node.children) : node.children;
    const inner = def.raw ? escapeHtml(plainText(node)) : renderNodes(children, { inList: node.name === 'list' });
    html += def.render(inner, node.attr, plainText(node));
  }
  return html;
}

/** Drops one leading and trailing newline inside block tags, so "[quote]\nhi\n[/quote]" doesn't add blank lines. */
function trimEdges(children) {
  if (!children.length) return children;
  const out = children.slice();
  const first = out[0];
  const last = out[out.length - 1];
  if (first.text !== undefined) out[0] = { text: first.text.replace(/^\r?\n/, '') };
  if (last.text !== undefined) out[out.length - 1] = { text: out[out.length - 1].text.replace(/\r?\n$/, '') };
  return out;
}

/** Strips block-tag newlines after closing tags like [/quote] so they don't stack up. */
function normalise(input) {
  return String(input || '').replace(/\r\n?/g, '\n').replace(/\[\/(quote|list|code|center|spoiler)\]\n/gi, '[/$1]').replace(/\[hr\]\n/gi, '[hr]');
}

/** BBCode → safe HTML. */
function render(input) {
  return renderNodes(parse(normalise(input)).children);
}

/** BBCode → plain text (for previews, notifications and snippets). Quotes are left out. */
function toPlain(input) {
  const strip = (nodes) => nodes.map((n) => {
    if (n.text !== undefined) return n.text;
    if (n.name === 'quote' || n.name === 'hr') return ' ';
    if (n.name === '*') return ` ${strip(n.children)} `;
    return strip(n.children) + (TAGS[n.name] && TAGS[n.name].block ? ' ' : '');
  }).join('');
  return strip(parse(normalise(input)).children).replace(/\s+/g, ' ').trim();
}

module.exports = { COLORS, SIZES: Object.keys(SIZES), escapeHtml, render, safeUrl, toPlain };
