'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const avatars = require('../src/avatars');
const images = require('../src/images');
const { parse } = require('../src/multipart');
const tuning = require('../src/tuning');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

// ----- Tiny but valid image files -----
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function makePng(w, h, { text = null } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const rows = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y += 1) rows[y * (w * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(text ? [pngChunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1'))] : []),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const seg = (marker, payload) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = marker; b.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([b, payload]); };
function makeJpeg(w, h) {
  const sof = Buffer.alloc(15);
  sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0GPS 51.5N 0.1W', 'latin1')),
    seg(0xfe, Buffer.from('secret comment', 'latin1')),
    seg(0xc0, sof),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]),
  ]);
}
function makeWebp(w, h) {
  const vp8l = Buffer.from([0x2f, (w - 1) & 0xff, (((w - 1) >> 8) & 0x3f) | (((h - 1) & 0x03) << 6), ((h - 1) >> 2) & 0xff, ((h - 1) >> 10) & 0x0f, 0, 0]);
  const chunk = (type, data) => { const b = Buffer.alloc(8); b.write(type, 0, 'latin1'); b.writeUInt32LE(data.length, 4); return Buffer.concat([b, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const body = Buffer.concat([chunk('VP8L', vp8l), chunk('EXIF', Buffer.from('GPS 51.5N', 'latin1'))]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

test('every badge part renders, and banners are escaped', () => {
  for (const s of avatars.SECTIONS) {
    for (const p of s.parts) {
      const svg = avatars.renderBadge({ ...avatars.DEFAULT_BADGE, [s.key]: p.id }, { level: 40, username: 'Ghost', unitTag: 'ABC' });
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*<\/svg>$/, `${s.key}:${p.id}`);
      assert.doesNotMatch(svg, /<script|\bon\w+=|href=/i);
    }
  }
  // Unit tags and callsigns are checked elsewhere, but escape anyway.
  const svg = avatars.renderBadge({ ...avatars.DEFAULT_BADGE, banner: 'unit' }, { unitTag: '<b>' });
  assert.match(svg, /\[&lt;b&gt;\]/);
  assert.match(avatars.renderBadge({ ...avatars.DEFAULT_BADGE, banner: 'grade' }, { level: 100 }), />GM-10</);
  // Defaults for any id are valid badges.
  for (let id = 1; id < 40; id += 1) assert.deepEqual(avatars.normalize(avatars.defaultBadge(id)).locked, []);
});

test('locked parts are refused and junk falls back', () => {
  const owner = { level: 1, titles: new Set() };
  const { badge, locked } = avatars.normalize({ shape: 'rosette', field: 'gold', emblem: 'crown', trim: 'nope', extra: 'x' }, { owner });
  assert.deepEqual(locked, ['Shape: Rosette', 'Field colour: Gold', 'Emblem: Crown']);
  assert.equal(badge.shape, 'shield');
  assert.equal(badge.trim, 'line');
  assert.equal(badge.extra, undefined);
  const vet = { level: 50, titles: new Set(['legend', 'veteran']) };
  assert.deepEqual(avatars.normalize({ shape: 'rosette', field: 'gold', emblem: 'crown', honours: 'laurel' }, { owner: vet }).locked, []);
  assert.equal(avatars.parseBadge('{not json', 3).shape, avatars.defaultBadge(3).shape);
  assert.match(avatars.unlockText(avatars.EMBLEMS.find((e) => e.id === 'crown')), /Living Legend/);
});

test('pictures: real type from the bytes, sizes checked, metadata removed', () => {
  const png = images.inspect(makePng(64, 48, { text: 'GPS 51.5N' }));
  assert.deepEqual([png.type, png.width, png.height], ['png', 64, 48]);
  assert.ok(!png.data.includes('GPS'));
  assert.ok(png.data.includes('IDAT'));

  const jpg = images.inspect(makeJpeg(300, 200));
  assert.deepEqual([jpg.type, jpg.width, jpg.height], ['jpeg', 300, 200]);
  assert.ok(!jpg.data.includes('GPS') && !jpg.data.includes('secret'));
  assert.ok(jpg.data.includes('JFIF'));
  assert.deepEqual([...jpg.data.subarray(-2)], [0xff, 0xd9]);

  const webp = images.inspect(makeWebp(120, 90));
  assert.deepEqual([webp.type, webp.width, webp.height], ['webp', 120, 90]);
  assert.ok(!webp.data.includes('GPS'));
  assert.equal(webp.data.readUInt32LE(4), webp.data.length - 8);

  assert.match(images.inspect(Buffer.from('GIF89a......')).error, /PNG, JPEG or WebP/);
  assert.match(images.inspect(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).error, /PNG, JPEG or WebP/);
  assert.match(images.inspect(makePng(16, 16)).error, /too small/);
  assert.match(images.inspect(makePng(5000, 40)).error, /too large/);
  assert.match(images.inspect(makePng(64, 64).subarray(0, 40)).error, /damaged/);
  assert.match(images.inspect(Buffer.alloc(2_000_000)).error, /too big/);
});

test('multipart parsing keeps fields and files and skips cut-off parts', () => {
  const b = 'XyZ';
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\ntok\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="picture"; filename="me.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from([1, 2, 13, 10, 3]),
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const out = parse(body, b);
  assert.equal(out.fields._csrf, 'tok');
  assert.deepEqual([...out.files.picture.data], [1, 2, 13, 10, 3]);
  const cut = parse(body.subarray(0, body.length - 12), b);
  assert.equal(cut.fields._csrf, 'tok');
  assert.equal(cut.files.picture, undefined);
});

test('avatars end to end: build, upload, report, moderate', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const request = async (p, { method = 'GET', form, body, headers = {} } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
        body: form ? new URLSearchParams(form) : body,
      });
      for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      const buf = Buffer.from(await res.arrayBuffer());
      return { res, buf, text: buf.toString('utf8'), location: res.headers.get('location') };
    };
    const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return { request, csrf };
  };
  const join = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    return c;
  };
  const upload = async (c, file, { token } = {}) => {
    const fd = new FormData();
    fd.append('_csrf', token ?? await c.csrf('/account/avatar'));
    fd.append('picture', new Blob([file], { type: 'image/png' }), 'me.png');
    return c.request('/account/avatar/upload', { method: 'POST', body: fd });
  };
  const flash = async (c, p = '/account/avatar') => (await c.request(p)).text.match(/class="flash[^"]*"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';
  try {
    // Signed-out visitors can't fetch avatars.
    assert.equal((await client().request('/avatars/1')).res.status, 401);

    const alpha = await join('Alpha');
    const bravo = await join('Bravo');

    // Everyone starts with a badge.
    let r = await alpha.request(`/avatars/${alpha.id}?v=0`);
    assert.equal(r.res.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.match(r.res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.res.headers.get('cache-control'), /immutable/);
    assert.match(r.text, />E-1</);

    // The builder page lists every section; locked parts are disabled.
    let page = (await alpha.request('/account/avatar')).text;
    for (const s of avatars.SECTIONS) assert.match(page, new RegExp(`<legend class="av-section__name">${s.name}</legend>`));
    assert.match(page, /id="av-field-gold" name="field" value="gold"\s+disabled/);
    assert.match(page, /Gold: reach level 30/);

    // Live preview doesn't save.
    r = await alpha.request('/avatars/preview?shape=hex&emblem=bolt&banner=callsign');
    assert.match(r.text, />ALPHA</);
    assert.equal(db.prepare('SELECT avatar_kind FROM users WHERE id = ?').get(alpha.id).avatar_kind, null);

    // Save a badge; a locked part is refused.
    let token = await alpha.csrf('/account/avatar');
    await alpha.request('/account/avatar/badge', { method: 'POST', form: { _csrf: token, shape: 'hex', field: 'navy', emblem: 'bolt', emblemColor: 'arctic', banner: 'level' } });
    let u = db.prepare('SELECT avatar_kind, avatar_badge, avatar_v FROM users WHERE id = ?').get(alpha.id);
    assert.equal(u.avatar_kind, 'badge');
    assert.equal(JSON.parse(u.avatar_badge).shape, 'hex');
    assert.equal(u.avatar_v, 1);
    assert.match((await alpha.request(`/avatars/${alpha.id}?v=1`)).text, />LV 1</);
    await alpha.request('/account/avatar/badge', { method: 'POST', form: { _csrf: token, shape: 'rosette', field: 'gold' } });
    assert.match(await flash(alpha), /haven’t unlocked Shape: Rosette, Field colour: Gold/);
    assert.equal(JSON.parse(db.prepare('SELECT avatar_badge FROM users WHERE id = ?').get(alpha.id).avatar_badge).shape, 'hex');

    // Uploads need level 3 (an admin setting) and a valid CSRF token.
    r = await upload(alpha, makePng(64, 64));
    assert.match(await flash(alpha), /Reach level 3 to upload/);
    db.prepare('UPDATE users SET level = 5').run();
    assert.equal((await upload(alpha, makePng(64, 64), { token: 'wrong' })).res.status, 403);
    // Too big: the reply still arrives and nothing is stored.
    r = await upload(alpha, Buffer.concat([makePng(64, 64), Buffer.alloc(1200 * 1024)]));
    assert.equal(r.res.status, 302);
    assert.match(await flash(alpha), /too big/);
    // Not a picture.
    await upload(alpha, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    assert.match(await flash(alpha), /PNG, JPEG or WebP/);
    // A real picture, with its text metadata stripped.
    await upload(alpha, makePng(80, 80, { text: 'GPS 51.5N' }));
    assert.match(await flash(alpha), /Picture uploaded/);
    u = db.prepare('SELECT avatar_kind, avatar_v FROM users WHERE id = ?').get(alpha.id);
    assert.equal(u.avatar_kind, 'upload');
    r = await bravo.request(`/avatars/${alpha.id}?v=${u.avatar_v}`);
    assert.equal(r.res.headers.get('content-type'), 'image/png');
    assert.ok(r.buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    assert.ok(!r.buf.includes('GPS'));

    // Switch back and forth between badge and picture.
    token = await alpha.csrf('/account/avatar');
    await alpha.request('/account/avatar/use', { method: 'POST', form: { _csrf: token, kind: 'badge' } });
    assert.equal((await bravo.request(`/avatars/${alpha.id}`)).res.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    // Only the owner (or an admin) sees a picture that isn't in use.
    assert.equal((await alpha.request(`/avatars/${alpha.id}?kind=upload`)).res.headers.get('content-type'), 'image/png');
    assert.equal((await bravo.request(`/avatars/${alpha.id}?kind=upload`)).res.status, 404);
    await alpha.request('/account/avatar/use', { method: 'POST', form: { _csrf: token, kind: 'upload' } });

    // Avatars show on profiles, in lists and in chat.
    const v = db.prepare('SELECT avatar_v FROM users WHERE id = ?').get(alpha.id).avatar_v;
    page = (await bravo.request('/profile/Alpha')).text;
    assert.ok(page.includes(`src="/avatars/${alpha.id}?v=${v}"`));
    assert.match(page, /Report picture/);
    assert.doesNotMatch((await alpha.request('/profile/Alpha')).text, /Report picture/);
    assert.ok((await bravo.request('/players')).text.includes(`/avatars/${alpha.id}?v=${v}`));
    assert.ok((await bravo.request('/leaderboards')).text.includes(`/avatars/${alpha.id}?v=${v}`));
    await alpha.request('/chat/global', { method: 'POST', form: { _csrf: await alpha.csrf('/chat/global'), body: 'Hello all' } });
    assert.ok((await bravo.request('/chat/global')).text.includes(`class="chat-msg__avatar"`));

    // Bravo reports it; reporting twice counts once.
    token = await bravo.csrf('/profile/Alpha');
    await bravo.request(`/avatars/${alpha.id}/report`, { method: 'POST', form: { _csrf: token, reason: 'rude picture' } });
    await bravo.request(`/avatars/${alpha.id}/report`, { method: 'POST', form: { _csrf: token, reason: 'again' } });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM avatar_reports').get().n, 1);
    // Can't report yourself.
    await alpha.request(`/avatars/${alpha.id}/report`, { method: 'POST', form: { _csrf: await alpha.csrf(), reason: 'x' } });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM avatar_reports').get().n, 1);

    // Admin area is hidden from players.
    assert.equal((await bravo.request('/admin/avatars')).res.status, 404);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(bravo.id);
    page = (await bravo.request('/admin')).text;
    assert.match(page, /Avatars <span class="count-badge">1<\/span>/);
    page = (await bravo.request('/admin/avatars')).text;
    assert.match(page, /rude picture/);
    assert.ok((await bravo.request('/admin/avatars?tab=recent')).text.includes('80 × 80'));

    // Remove it and block further uploads.
    await bravo.request(`/admin/avatars/${alpha.id}/remove`, { method: 'POST', form: { _csrf: await bravo.csrf('/admin/avatars'), reason: 'Not allowed', block: '1' } });
    u = db.prepare('SELECT avatar_kind, avatar_upload_blocked FROM users WHERE id = ?').get(alpha.id);
    assert.deepEqual([u.avatar_kind, u.avatar_upload_blocked], ['badge', 1]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM avatar_uploads').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM avatar_reports WHERE status = 'open'").get().n, 0);
    assert.match(db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC').get(alpha.id).message, /removed your avatar picture: Not allowed/);
    assert.match(db.prepare("SELECT details FROM admin_actions WHERE action = 'avatar-remove'").get().details, /blocked uploads/);
    assert.match((await alpha.request('/account/avatar')).text, /An admin has turned off picture uploads/);
    await upload(alpha, makePng(64, 64));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM avatar_uploads').get().n, 0);

    // Admins can switch uploads off for everyone.
    tuning.set({ avatarUploadsOpen: false });
    assert.match((await bravo.request('/account/avatar')).text, /Picture uploads are switched off/);
  } finally {
    tuning.reset();
    server.close();
  }
});
