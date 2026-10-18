'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const support = require('../src/support');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const fakeSub = () => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(12).toString('hex')}`,
  keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
});

test('support rules', () => {
  assert.match(support.validateSubject('hi').error, /at least 4/);
  assert.equal(support.validateSubject('  Raid   loot missing ').subject, 'Raid loot missing');
  assert.match(support.validateBody('short').error, /at least 10/);
  assert.equal(support.validateBody('ok', { min: 1 }).body, 'ok');
  assert.match(support.validateBody('x'.repeat(support.MAX_BODY + 1)).error, /limited/);
  assert.match(support.openBlocker({ openCount: 3, todayCount: 0 }), /3 tickets open/);
  assert.match(support.openBlocker({ openCount: 0, todayCount: 5 }), /5 tickets today/);
  assert.equal(support.openBlocker({ openCount: 2, todayCount: 4 }), null);
});

test('support tickets end to end, with push alerts for admins', async () => {
  const sent = [];
  const pushSender = async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); };
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false, pushSender });
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
      return { res, text: await res.text(), location: res.headers.get('location') };
    };
    c.csrf = async (from = '/hq') => (await c.request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    c.act = async (path, form = {}, from = '/hq') => {
      const r = await c.request(path, { method: 'POST', form: { _csrf: await c.csrf(from), ...form } });
      const page = r.location ? (await c.request(r.location)).text : '';
      return { location: r.location, page, message: (page.match(/class="flash flash--\w+"[^>]*>([^<]*)</) || [])[1] || '' };
    };
    return c;
  };
  const join = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    return c;
  };
  const settle = async () => { await new Promise((r) => setImmediate(r)); await app.push.settle(); };
  const ticket = (id) => db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id);
  const notes = (id, kind) => db.prepare('SELECT message, link FROM notifications WHERE user_id = ? AND kind = ? ORDER BY id').all(id, kind);
  try {
    const boss = await join('Boss');
    const boss2 = await join('Boss2');
    const rook = await join('Rook');
    const other = await join('Other');
    db.prepare("UPDATE users SET is_admin = 1 WHERE username IN ('Boss', 'Boss2')").run();
    // Boss has the app on one device, with every player category switched off:
    // support alerts have their own switch, so they still arrive.
    app.push.subscribe(boss.id, fakeSub(), 'Mozilla/5.0 (iPhone)');
    app.push.setPrefs(boss.id, { categories: [] });

    let page = (await rook.request('/support')).text;
    assert.match(page, /Help &amp; support/);
    assert.match(page, /You haven’t opened any tickets/);
    assert.match((await rook.request('/hq')).text, /href="\/support"/, 'linked from the menu and footer');

    // Mistakes keep the draft.
    let r = await rook.act('/support', { category: 'nope', subject: 'Raid loot missing', body: 'My share never arrived after the raid.' }, '/support/new');
    assert.match(r.message, /Choose what your ticket is about/);
    assert.match(r.page, /value="Raid loot missing"/);
    assert.match(r.page, /My share never arrived after the raid\./);

    r = await rook.act('/support', { category: 'unit', subject: 'Raid loot missing', body: 'My share never arrived after the [b]raid[/b].' }, '/support/new');
    assert.match(r.message, /Ticket #1 sent/);
    assert.equal(r.location, '/support/1');
    assert.match(r.page, /<strong>raid<\/strong>/, 'BBCode is rendered');
    assert.equal(ticket(1).status, 'open');

    // Every admin hears about it in-game; Boss also gets a push.
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.title, 'Support ticket');
    assert.match(sent[0].payload.body, /New support ticket #1 from Rook \(Units, raids and the map\): Raid loot missing/);
    assert.equal(sent[0].payload.url, '/admin/support/1#latest');
    assert.equal(notes(boss.id, 'support-staff').length, 1);
    assert.equal(notes(boss2.id, 'support-staff').length, 1);

    // Tickets are private.
    assert.equal((await other.request('/support/1')).res.status, 404);
    assert.match((await other.act('/support/1/reply', { body: 'Sneaky' }, '/support')).message, /Ticket not found/);
    assert.equal((await rook.request('/admin/support')).res.status, 404);

    // The queue, with a count in the admin menu.
    page = (await boss.request('/admin/support')).text;
    assert.match(page, /#1 Raid loot missing/);
    assert.match(page, /class="admin-nav__count" aria-label="1 waiting">1</);
    assert.match(page, /Push alerts for new tickets: <strong>on<\/strong>/);

    // An internal note: the player never sees it and isn't told.
    r = await boss.act('/admin/support/1/reply', { body: 'Checked the ledger: raid-loot paid at 14:02.', internal: 'on' }, '/admin/support/1');
    assert.match(r.message, /Note added/);
    assert.match(r.page, /internal note/);
    assert.equal(ticket(1).status, 'open');
    assert.equal(notes(rook.id, 'support').length, 0);
    assert.doesNotMatch((await rook.request('/support/1')).text, /Checked the ledger/);

    // A reply: the player is told, the ticket waits for them, and Boss now owns it.
    r = await boss.act('/admin/support/1/reply', { body: 'It was paid to your cash. Check your [b]Bank[/b] page.' }, '/admin/support/1');
    assert.match(r.message, /Reply sent/);
    assert.equal(ticket(1).status, 'answered');
    assert.equal(ticket(1).assigned_to, boss.id);
    assert.match(notes(rook.id, 'support')[0].message, /HQ Support replied to your ticket “Raid loot missing”/);
    assert.match((await rook.request('/support')).text, /New reply/);
    page = (await rook.request('/support/1')).text;
    assert.match(page, /HQ Support <span class="muted">· Boss<\/span>/);
    assert.match(page, /Check your <strong>Bank<\/strong> page/);
    assert.doesNotMatch((await rook.request('/support')).text, /New reply/, 'reading it clears the badge');

    // The player answers: only the assignee (Boss) hears, not Boss2.
    sent.length = 0;
    db.prepare('UPDATE support_messages SET created_at = created_at - 60000').run(); // past the reply cooldown
    r = await rook.act('/support/1/reply', { body: 'Found it, thanks!' }, '/support/1');
    assert.equal(ticket(1).status, 'open');
    await settle();
    assert.equal(sent.length, 1);
    assert.match(sent[0].payload.body, /Rook replied on ticket #1: Found it, thanks!/);
    assert.equal(notes(boss2.id, 'support-staff').length, 1);
    // Replying too fast is refused.
    assert.match((await rook.act('/support/1/reply', { body: 'And again' }, '/support/1')).message, /too quickly/);

    // Assigning, closing and reopening.
    r = await boss.act('/admin/support/1/assign', { to: String(boss2.id) }, '/admin/support/1');
    assert.match(r.message, /Assigned to Boss2/);
    r = await boss.act('/admin/support/1/status', { status: 'closed' }, '/admin/support/1');
    assert.match(r.message, /Ticket closed/);
    assert.equal(ticket(1).status, 'closed');
    assert.match(notes(rook.id, 'support').at(-1).message, /closed your ticket/);
    assert.match((await boss.act('/admin/support/1/status', { status: 'closed' }, '/admin/support/1')).message, /already closed/);
    db.prepare('UPDATE support_messages SET created_at = created_at - 60000').run(); // past the reply cooldown
    r = await rook.act('/support/1/reply', { body: 'Actually one more thing.' }, '/support/1');
    assert.match(r.message, /Ticket reopened/);
    assert.equal(ticket(1).status, 'open');

    // Boss switches push alerts off: still told in-game, but no push.
    r = await boss.act('/admin/support/alerts', { on: '0' }, '/admin/support');
    assert.match(r.message, /Push alerts for support tickets are off/);
    sent.length = 0;
    await other.act('/support', { category: 'bug', subject: 'Map is blank', body: 'The theatre map shows nothing on my phone.' }, '/support/new');
    await settle();
    assert.equal(sent.length, 0);
    assert.match(notes(boss.id, 'support-staff').at(-1).message, /New support ticket #2 from Other/);

    // Limits: three open tickets at a time.
    db.prepare('UPDATE support_messages SET created_at = created_at - 60000').run();
    for (const n of [2, 3]) await rook.act('/support', { category: 'other', subject: `Question ${n}`, body: 'Another question for HQ, please.' }, '/support/new');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ? AND status != 'closed'").get(rook.id).n, 3);
    assert.match((await rook.request('/support')).text, /You already have 3 tickets open/);
    assert.match((await rook.act('/support', { category: 'other', subject: 'Question 4', body: 'Yet another question for HQ.' }, '/support/new')).message, /3 tickets open/);
    // The player can close their own ticket.
    r = await rook.act('/support/3/close', {}, '/support/3');
    assert.match(r.message, /Ticket closed/);

    // Answered tickets nobody comes back to close after a week.
    db.prepare("UPDATE support_tickets SET status = 'answered', last_staff_at = ? WHERE id = 4").run(Date.now() - support.AUTO_CLOSE_MS - 1000);
    assert.equal(app.support.autoClose(), 1);
    assert.equal(ticket(4).status, 'closed');
    assert.match(notes(rook.id, 'support').at(-1).message, /closed after a week without a reply/);

    // The queue tabs.
    page = (await boss.request('/admin/support?status=closed')).text;
    assert.match(page, /#3 Question 2|#4 Question 3/);
    assert.match((await boss.request('/admin/support?mine=1')).text, /Nothing waiting|No tickets here/);
  } finally {
    server.close();
  }
});
