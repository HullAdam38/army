'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chat = require('../src/chat');
const { createChatService } = require('../src/chat-service');
const { createPlayerRepo } = require('../src/players');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('chat rules: channels, validation, cooldowns, mutes and mentions', () => {
  const now = Date.now();
  assert.deepEqual(chat.channelFor('global', {}), { key: 'global', slug: 'global', name: 'Global' });
  assert.equal(chat.channelFor('unit', { unit_id: null }, null), null);
  assert.equal(chat.channelFor('unit', { unit_id: 4 }, { id: 4, tag: 'GHO', name: 'Ghosts' }).key, 'unit:4');
  assert.equal(chat.channelFor('nope', { unit_id: 4 }, { id: 4 }), null);

  assert.match(chat.validateBody('   ').error, /Write a message/);
  assert.match(chat.validateBody('x'.repeat(501)).error, /500 characters/);
  assert.equal(chat.validateBody('a\r\n\n\n\nb').body, 'a\n\nb');
  assert.equal(chat.validateBody(Array(12).fill('l').join('\n')).body.split('\n').length, chat.MAX_LINES);

  const p = { level: 5 };
  assert.match(chat.postBlocker({ level: 1 }, 'hi', null, now), /level 2/);
  assert.match(chat.postBlocker({ ...p, chat_muted_until: now + 30 * 60000, chat_mute_reason: 'spam' }, 'hi', null, now), /muted for another 30 minutes \(spam\)/);
  assert.match(chat.postBlocker({ ...p, chat_muted_until: now + 5 * 3600000 }, 'hi', null, now), /5 hours/);
  assert.match(chat.postBlocker(p, 'hi', { body: 'x', created_at: now - 1000 }, now), /Slow down/);
  assert.match(chat.postBlocker(p, 'hi', { body: 'hi', created_at: now - 10000 }, now), /just sent that/);
  assert.equal(chat.postBlocker(p, 'hi', { body: 'hi', created_at: now - 120000 }, now), null);

  assert.deepEqual(chat.mentionsIn('@Ace and @ace, @Rook! mail me@x.com @Bo @Kay_1 @Zed'), ['Ace', 'Rook', 'Kay_1']);
  const names = new Map([['ace', 'Ace']]);
  assert.equal(chat.linkMentions('<p>hi @ace</p>', names, 'Ace'), '<p>hi <a class="chat-mention chat-mention--you" href="/profile/Ace">@Ace</a></p>');
  // Never inside URLs or for unknown players.
  assert.equal(chat.linkMentions('<a href="https://x.com/@ace">x</a> @ghost', names), '<a href="https://x.com/@ace">x</a> @ghost');
});

test('chat service: post, history, blocks, live polling, delete, report, mute, mentions, prune', () => {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const svc = createChatService(db, players);
  const now = Date.now();
  const add = (name, level = 5) => {
    const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at, level)
                                  VALUES (?, ?, 'x', ?, ?, ?, ?)`).run(name, `${name}@x`, now, now, now, level).lastInsertRowid);
    return () => players.findById(id);
  };
  const ace = add('Ace');
  const rook = add('Rook');
  const newbie = add('Newbie', 1);

  assert.match(svc.post({ me: newbie(), channel: 'global', channelName: 'Global', raw: 'hi', now }).error, /level 2/);
  const first = svc.post({ me: ace(), channel: 'global', channelName: 'Global', raw: '[b]Morning[/b] @rook <script>x</script>', now });
  assert.ok(first.message.id);
  assert.match(first.message.html, /<strong>Morning<\/strong> <a class="chat-mention" href="\/profile\/Rook">@Rook<\/a> &lt;script&gt;/);
  // Rook was notified of the mention.
  assert.match(db.prepare("SELECT message, link FROM notifications WHERE kind = 'chat' AND user_id = ?").get(rook().id).message, /Ace mentioned you in Global chat: “Morning @rook <script>x<\/script>”/);
  // Cooldown, then a second message.
  assert.match(svc.post({ me: ace(), channel: 'global', channelName: 'Global', raw: 'again', now: now + 1000 }).error, /Slow down/);
  const second = svc.post({ me: rook(), channel: 'global', channelName: 'Global', raw: 'Hey @Ace', now: now + 2000 });

  // History is oldest first and marks mentions of the viewer.
  let hist = svc.history('global', ace());
  assert.deepEqual(hist.map((m) => m.id), [first.message.id, second.message.id]);
  assert.deepEqual([hist[0].mine, hist[1].mentionsMe], [true, true]);
  // Blocking hides their messages from you.
  db.prepare('INSERT INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)').run(ace().id, rook().id, now);
  assert.deepEqual(svc.history('global', ace()).map((m) => m.id), [first.message.id]);
  // …and they can't ping you any more.
  svc.post({ me: rook(), channel: 'global', channelName: 'Global', raw: '@Ace hello?', now: now + 10000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'chat' AND user_id = ?").get(ace().id).n, 1);

  // Unit channels: mentions only notify players who can read it.
  svc.post({ me: ace(), channel: 'unit:9', channelName: '[GHO] unit', raw: '@Newbie see this?', canSee: (u) => u.unit_id === 9, now: now + 20000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'chat' AND user_id = ?").get(newbie().id).n, 0);
  assert.equal(svc.history('global', rook()).length, 3); // unit messages stay in their channel

  // Polling returns only newer messages, and deletions.
  const polled = svc.poll('global', rook(), first.message.id, now + 30000);
  assert.deepEqual(polled.messages.map((m) => m.body), ['Hey @Ace', '@Ace hello?']);
  assert.match(svc.remove(first.message.id, rook()).error, /only delete your own/);
  assert.equal(svc.remove(first.message.id, ace(), now + 30000).byAdmin, false);
  assert.deepEqual(svc.poll('global', rook(), 0, now + 31000).deleted, [first.message.id]);
  assert.match(svc.remove(first.message.id, ace()).error, /already gone/);

  // Reports keep a copy; once per reporter; resolving clears every report on the message.
  assert.match(svc.report(second.message.id, rook(), 'x').error, /own message/);
  assert.equal(svc.report(second.message.id, ace(), '  rude   words ').added, true);
  assert.equal(svc.report(second.message.id, ace(), 'again').added, false);
  svc.report(second.message.id, newbie(), null);
  assert.equal(svc.openReportCount(), 2);
  const [r] = svc.reports('open');
  assert.deepEqual([r.reason === null || r.reason === 'rude words', r.times_reported, r.author], [true, 2, 'Rook']);
  assert.equal(svc.resolveReports(second.message.id, ace().id, 'dismissed'), 2);
  assert.equal(svc.openReportCount(), 0);

  // Mutes.
  svc.mute(rook().id, chat.MUTES['1h'].ms, 'spam', now);
  assert.match(svc.post({ me: rook(), channel: 'global', channelName: 'Global', raw: 'let me talk', now: now + 60000 }).error, /muted/);
  assert.deepEqual(svc.muted(now + 60000).map((u) => u.username), ['Rook']);
  svc.unmute(rook().id);
  assert.ok(svc.post({ me: rook(), channel: 'global', channelName: 'Global', raw: 'thanks', now: now + 70000 }).message);

  // Old messages are pruned.
  const stored = db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n;
  assert.equal(svc.prune(now + 29 * 24 * 3600 * 1000), 0);
  assert.equal(svc.prune(now + 31 * 24 * 3600 * 1000), stored);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, 0);
  assert.equal(svc.reports('resolved').length, 2); // reports keep their copy
});

test('chat in the app: channels, posting with and without JS, moderation', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const request = async (p, { method = 'GET', form, json = false } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: {
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(json ? { accept: 'application/json' } : {}),
        },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      const text = await res.text();
      return { res, text, location: res.headers.get('location'), json: () => JSON.parse(text) };
    };
    const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return {
      request,
      post: async (p, form = {}, opts = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...form }, ...opts }),
      async enlist(username) {
        await request('/register', { method: 'POST', form: { _csrf: await csrf('/register'), username, email: `${username}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
      },
    };
  };
  try {
    const ace = client(); await ace.enlist('Ace');
    const rook = client(); await rook.enlist('Rook');

    // New accounts read but can't post yet.
    let page = (await ace.request('/chat/global')).text;
    assert.match(page, /Global chat/);
    assert.match(page, /Reach level 2 to chat/);
    assert.equal((await ace.request('/chat')).location, '/chat/global');
    db.prepare('UPDATE users SET level = 5').run();

    // Without JS: the form posts and redirects to the message.
    let r = await ace.post('/chat/global', { body: 'Hello [i]regiment[/i] @Rook' });
    assert.match(r.location, /^\/chat\/global#m-\d+$/);
    page = (await rook.request('/chat/global')).text;
    assert.match(page, /Hello <em>regiment<\/em> <a class="chat-mention chat-mention--you" href="\/profile\/Rook">@Rook<\/a>/);
    assert.match((await rook.request('/notifications')).text, /Ace mentioned you in Global chat/);

    // With JS: JSON in, rendered HTML out; errors come back as JSON too.
    r = await rook.post('/chat/global', { body: 'Morning <b>sir</b>' }, { json: true });
    const sent = r.json();
    assert.equal(sent.ok, true);
    assert.match(sent.html, /Morning &lt;b&gt;sir&lt;\/b&gt;/);
    r = await rook.post('/chat/global', { body: 'spam' }, { json: true });
    assert.equal(r.res.status, 400);
    assert.match(r.json().error, /Slow down/);
    // A failed post without JS keeps the draft.
    r = await rook.post('/chat/global', { body: 'my draft' });
    assert.equal(r.location, '/chat/global#composer');
    assert.match((await rook.request('/chat/global')).text, /my draft<\/textarea>/);
    // Muted players see why instead of the composer.
    db.prepare("UPDATE users SET chat_muted_until = ? WHERE username = 'Rook'").run(Date.now() + 600000);
    page = (await rook.request('/chat/global')).text;
    assert.match(page, /muted for another 10 minutes/);
    assert.doesNotMatch(page, /data-chat-form/);
    db.prepare("UPDATE users SET chat_muted_until = NULL WHERE username = 'Rook'").run();

    // Live polling picks up new messages.
    const poll = (await ace.request(`/chat/global/poll?after=${sent.id - 1}`)).json();
    assert.deepEqual(poll.messages.map((m) => m.id), [sent.id]);

    // Unit channel: members only.
    assert.equal((await ace.request('/chat/unit')).location, '/chat/global');
    db.prepare("INSERT INTO units (name, tag, founded_by, created_at) VALUES ('Ghost Company', 'GHO', (SELECT id FROM users WHERE username = 'Ace'), 0)").run();
    db.prepare("UPDATE users SET unit_id = (SELECT id FROM units), unit_role = 'commander' WHERE username = 'Ace'").run();
    page = (await ace.request('/chat/unit')).text;
    assert.match(page, /\[GHO\] Ghost Company/);
    db.prepare('UPDATE chat_messages SET created_at = created_at - 60000').run(); // past the posting cooldown
    r = await ace.post('/chat/unit', { body: 'Unit only' });
    assert.match(r.location, /^\/chat\/unit#m-\d+$/);
    const unitMsg = Number(r.location.split('#m-')[1]);
    assert.doesNotMatch((await rook.request('/chat/global')).text, /Unit only/);
    assert.equal((await rook.request('/chat/unit/poll?after=0')).res.status, 404);
    // Outsiders can't touch unit messages.
    assert.equal((await rook.post(`/chat/messages/${unitMsg}/report`)).res.status, 404);

    // Report, then an admin deletes and mutes from the moderation page.
    assert.equal((await ace.post(`/chat/messages/${sent.id}/report`, { reason: 'rude' })).location, `/chat/global#m-${sent.id}`);
    assert.equal((await rook.request('/admin/chat')).res.status, 404);
    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Ace'").run();
    page = (await ace.request('/admin/chat')).text;
    assert.match(page, /reported[\s\S]*Rook[\s\S]*Reason: “rude”/);
    assert.match((await ace.request('/admin')).text, /Chat <span class="count-badge">1<\/span>/);
    const reportId = db.prepare('SELECT id FROM chat_reports').get().id;
    await ace.post(`/admin/chat/reports/${reportId}`, { action: 'mute', duration: '24h', note: 'be nice' });
    const rookRow = db.prepare("SELECT chat_muted_until, chat_mute_reason FROM users WHERE username = 'Rook'").get();
    assert.ok(rookRow.chat_muted_until > Date.now() + 23 * 3600000);
    assert.equal(rookRow.chat_mute_reason, 'be nice');
    assert.ok(db.prepare('SELECT deleted_at FROM chat_messages WHERE id = ?').get(sent.id).deleted_at);
    assert.match((await rook.request('/chat/global')).text, /muted for another 24 hours \(be nice\)/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'chat-report'").get().n, 1);
    // Unmute from the moderation page.
    const rookId = db.prepare("SELECT id FROM users WHERE username = 'Rook'").get().id;
    await ace.post(`/admin/chat/unmute/${rookId}`);
    assert.equal(db.prepare('SELECT chat_muted_until FROM users WHERE id = ?').get(rookId).chat_muted_until, null);
    // Deleting your own message with JS.
    r = await ace.post(`/chat/messages/${unitMsg}/delete`, {}, { json: true });
    assert.equal(r.json().ok, true);
  } finally {
    server.close();
  }
});
