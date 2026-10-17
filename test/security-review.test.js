'use strict';

// Regression tests for the security review of avatars, uploads, push alerts,
// admin tools, unit objectives and the high-value target (see SECURITY.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const images = require('../src/images');
const { multipart } = require('../src/multipart');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('uploads are only read for signed-in sessions', () => {
  const mw = multipart({ paths: ['/account/avatar/upload'], maxBytes: 1024 });
  const fake = (session) => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', path: '/account/avatar/upload', session, get: () => 'multipart/form-data; boundary=x' });
    return req;
  };
  let called = 0;
  const anon = fake({});
  mw(anon, {}, () => { called += 1; });
  assert.equal(called, 1, 'passed straight on');
  assert.equal(anon.listenerCount('data'), 0, 'body not read');
  const signedIn = fake({ userId: 7 });
  mw(signedIn, {}, () => { called += 1; });
  assert.equal(signedIn.listenerCount('data'), 1, 'body read for a player');
});

test('JPEGs end at their end-of-image marker (no hidden trailing files)', () => {
  const seg = (marker, payload) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = marker; b.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([b, payload]); };
  const sof = Buffer.alloc(15);
  sof[0] = 8; sof.writeUInt16BE(64, 1); sof.writeUInt16BE(64, 3); sof[5] = 3;
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xc0, sof),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9]), // stuffed byte, restart marker, end of image
    Buffer.from('<html><script>alert(1)</script></html>'),
  ]);
  const out = images.inspect(jpeg);
  assert.equal(out.type, 'jpeg');
  assert.deepEqual([...out.data.subarray(-2)], [0xff, 0xd9]);
  assert.ok(!out.data.includes('<html>'));
  assert.ok(out.data.includes(Buffer.from([0xff, 0x00, 0x34, 0xff, 0xd0])), 'picture data kept intact');
});

test('objective XP needs a real share; suspended sessions get no avatars', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const c = {};
    c.request = async (p, { method = 'GET', form } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text() };
    };
    c.csrf = async (from = '/hq') => (await c.request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return c;
  };
  const join = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    return c;
  };
  try {
    const worker = await join('Worker');
    const token = await join('Token');
    const unitId = Number(db.prepare("INSERT INTO units (name, tag, created_at) VALUES ('Iron Wolves', 'IW', ?)").run(Date.now()).lastInsertRowid);
    db.prepare("UPDATE users SET unit_id = ?, unit_role = 'member'").run(unitId);
    app.objectives.current(unitId);
    db.prepare("UPDATE unit_objectives SET type = 'donations', target = 10000 WHERE unit_id = ? AND slot = 0").run(unitId);
    const xp = (id) => db.prepare('SELECT level * 1000000 + xp AS n FROM users WHERE id = ?').get(id).n;
    const before = { worker: xp(worker.id), token: xp(token.id) };
    app.objectives.track(token.id, 'donations', 1); // a $1 "donation"
    app.objectives.track(worker.id, 'donations', 9999);
    assert.ok(db.prepare('SELECT completed_at FROM unit_objectives WHERE unit_id = ? AND slot = 0').get(unitId).completed_at);
    assert.ok(xp(worker.id) > before.worker, 'a real contributor is rewarded');
    assert.equal(xp(token.id), before.token, 'a token contribution earns nothing');

    // A suspended account's session can't fetch avatars.
    assert.equal((await worker.request(`/avatars/${token.id}`)).res.status, 200);
    db.prepare('UPDATE users SET banned_at = ? WHERE id = ?').run(Date.now(), worker.id);
    assert.equal((await worker.request(`/avatars/${token.id}`)).res.status, 401);
    assert.equal((await worker.request('/avatars/preview')).res.status, 401);

    // Without a session, an upload is refused by the CSRF check without being read.
    const fd = new FormData();
    fd.append('picture', new Blob([Buffer.alloc(500 * 1024)], { type: 'image/png' }), 'x.png');
    assert.equal((await fetch(`${base}/account/avatar/upload`, { method: 'POST', body: fd })).status, 403);
  } finally {
    server.close();
  }
});
