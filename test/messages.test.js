'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bbcode = require('../src/bbcode');
const rules = require('../src/messages');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('BBCode renders the supported tags', () => {
  assert.equal(bbcode.render('[b]bold[/b] [i]it[/i] [u]u[/u] [s]x[/s]'), '<strong>bold</strong> <em>it</em> <span class="bb-u">u</span> <s>x</s>');
  assert.equal(bbcode.render('[color=red]r[/color][color=#0f0]g[/color]'), '<span class="bb-color" style="color:red">r</span><span class="bb-color" style="color:#0f0">g</span>');
  assert.equal(bbcode.render('[size=large]L[/size]'), '<span class="bb-size-large">L</span>');
  assert.equal(bbcode.render('[quote=Bob]\nhi\n[/quote]\nafter'), '<blockquote class="bb-quote"><cite>Bob wrote:</cite>hi</blockquote>after');
  assert.equal(bbcode.render('[list]\n[*]one\n[*]two\n[/list]'), '<ul class="bb-list"><li>one</li><li>two</li></ul>');
  assert.equal(bbcode.render('[list=1][*]a[/list]'), '<ol class="bb-list" type="1"><li>a</li></ol>');
  assert.equal(bbcode.render('[code][b]raw[/b][/code]'), '<pre class="bb-code"><code>[b]raw[/b]</code></pre>');
  assert.match(bbcode.render('[spoiler]s[/spoiler]'), /<details class="bb-spoiler"><summary>Spoiler<\/summary><div>s<\/div><\/details>/);
  assert.equal(bbcode.render('[url=https://example.com]site[/url]'), '<a href="https://example.com/" rel="nofollow noopener noreferrer ugc" target="_blank">site</a>');
  assert.equal(bbcode.render('[url]https://example.com/a?b=1&c=2[/url]'), '<a href="https://example.com/a?b=1&amp;c=2" rel="nofollow noopener noreferrer ugc" target="_blank">https://example.com/a?b=1&amp;c=2</a>');
  assert.equal(bbcode.render('[player]Commander[/player]'), '<a class="bb-player" href="/profile/Commander">Commander</a>');
  assert.equal(bbcode.render('line one\nline two'), 'line one<br>line two');
  assert.equal(bbcode.render('[b]unclosed'), '<strong>unclosed</strong>');
  assert.equal(bbcode.render('[b][i]x[/b] y'), '<strong><em>x</em></strong> y'); // mis-nesting closes cleanly
  assert.equal(bbcode.toPlain('[quote=Bob]old[/quote]Hi [b]there[/b] [list][*]a[*]b[/list]'), 'Hi there a b');
});

test('BBCode can’t be used to inject markup or scripts', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[url=javascript:alert(1)]x[/url]',
    '[url]javascript:alert(1)[/url]',
    '[url=data:text/html,<script>alert(1)</script>]x[/url]',
    '[url=https://ex.com/"onmouseover="alert(1)]x[/url]',
    '[url=https://user:pass@ex.com]x[/url]',
    '[color=red;background:url(javascript:x)]c[/color]',
    '[color=expression(alert(1))]c[/color]',
    '[size=100px]x[/size]',
    '[quote="><script>alert(1)</script>]q[/quote]',
    '[player]<b>x</b>[/player]',
    '[list=disc onclick=alert(1)][*]x[/list]',
    '[code]</code><script>alert(1)</script>[/code]',
  ];
  for (const a of attacks) {
    const html = bbcode.render(a);
    // Escaped text may mention "onerror"; what matters is that no real tag carries it.
    for (const tag of html.match(/<[^>]+>/g) || []) {
      assert.doesNotMatch(tag, /^<(script|img|iframe)|\son\w+\s*=|javascript:|data:text|expression\(|user:pass/i, `${a} → ${tag}`);
      assert.match(tag, /^<\/?(strong|em|span|s|div|blockquote|cite|details|summary|a|ul|ol|li|pre|code|hr|br)[\s>]/, `${a} → unexpected ${tag}`);
    }
  }
  // Quote attributes are text, never markup.
  assert.match(bbcode.render('[quote=<b>x</b>]q[/quote]'), /<cite>&lt;b&gt;x&lt;\/b&gt; wrote:<\/cite>/);
  // Deep nesting is capped rather than unbounded.
  const deep = '[quote]'.repeat(10) + 'x' + '[/quote]'.repeat(10);
  assert.equal((bbcode.render(deep).match(/<blockquote/g) || []).length, 3);
});

test('message rules', () => {
  assert.match(rules.validateBody('   ').error, /Write a message/);
  assert.match(rules.validateBody('x'.repeat(5001)).error, /5,000 characters/);
  assert.equal(rules.validateBody('hi\r\n\r\n\r\n\r\n\r\nthere').body, 'hi\n\n\nthere');
  assert.match(rules.validateSubject('').error, /subject/);
  const a = { id: 1, username: 'A', level: 2 };
  const b = { id: 2, username: 'B', level: 1 };
  const ok = { starting: true, blockedBySender: false, blockedByRecipient: false, lastSentAt: null, startedToday: 0 };
  assert.equal(rules.sendBlocker(a, b, ok), null);
  assert.match(rules.sendBlocker(a, a, ok), /yourself/);
  assert.match(rules.sendBlocker(a, b, { ...ok, blockedByRecipient: true }), /isn’t accepting/);
  assert.match(rules.sendBlocker(a, b, { ...ok, blockedBySender: true }), /You’ve blocked/);
  assert.match(rules.sendBlocker(b, a, ok), /level 2/);
  assert.equal(rules.sendBlocker(b, a, { ...ok, starting: false }), null); // replies are fine
  assert.match(rules.sendBlocker(a, b, { ...ok, startedToday: 20 }), /20 conversations/);
  assert.match(rules.sendBlocker(a, b, { ...ok, lastSentAt: Date.now() - 1000 }), /Slow down/);
});

test('private messages end to end: send, read, reply, quote, preview, block, report, delete', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const request = async (p, { method = 'GET', form, json, headers = {} } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: {
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(json ? { 'content-type': 'application/json', accept: 'application/json' } : {}),
          ...headers,
        },
        body: form ? new URLSearchParams(form) : json ? JSON.stringify(json) : undefined,
      });
      for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text(), location: res.headers.get('location') };
    };
    const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    const flash = async (p, form = {}) => {
      const r = await request(p, { method: 'POST', form: { _csrf: await csrf(), ...form } });
      const page = (await request(r.location)).text;
      const m = page.match(/<p class="flash flash--(\w+)">([^<]*)<\/p>/);
      return { location: r.location, message: m ? m[2] : '', page };
    };
    return { request, csrf, flash };
  };
  const enlist = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/register'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    return c;
  };
  try {
    const alpha = await enlist('Alpha');
    const bravo = await enlist('Bravo');
    const id = (n) => db.prepare('SELECT id FROM users WHERE username = ?').get(n).id;

    // Level 1 can't start conversations.
    assert.match((await alpha.flash('/messages', { to: 'Bravo', subject: 'Hi', body: 'yo' })).message, /Reach level 2/);
    db.prepare('UPDATE users SET level = 2').run();
    const nobody = await alpha.flash('/messages', { to: 'Nobody', subject: 'Hi', body: 'yo' });
    assert.match(nobody.message, /No soldier/);
    assert.match(nobody.page, /value="Nobody"/); // the draft survives an error

    const body = '[b]Meet at the bridge[/b]\n<script>alert(1)</script>\n[url=javascript:alert(1)]click[/url]';
    let f = await alpha.flash('/messages', { to: 'bravo', subject: 'Orders <now>', body });
    assert.match(f.message, /Message sent to Bravo/);
    const convoUrl = f.location;
    assert.match(f.page, /<strong>Meet at the bridge<\/strong>/);
    assert.doesNotMatch(f.page, /<script>alert/);
    assert.match(f.page, /Orders &lt;now&gt;/);

    // Bravo sees it as unread in the header and inbox, then reads it.
    let hq = (await bravo.request('/hq')).text;
    assert.match(hq, /aria-label="Messages, 1 unread"/);
    const poll = JSON.parse((await bravo.request('/notifications/poll?after=0', { headers: { accept: 'application/json' } })).text);
    assert.equal(poll.messages, 1);
    assert.match((await bravo.request('/messages')).text, /is-unread[\s\S]*Alpha[\s\S]*Meet at the bridge/);
    const thread = (await bravo.request(convoUrl)).text;
    assert.match(thread, /data-bb-quote="#body" data-author="Alpha"/);
    assert.match(thread, /data-body="\[b\]Meet at the bridge\[\/b\]\n&lt;script&gt;/); // raw BBCode for quoting, escaped
    assert.match((await bravo.request('/hq')).text, /aria-label="Messages"/);

    // Reply; Alpha now has it unread.
    db.prepare('UPDATE messages SET created_at = created_at - 10000').run(); // step past the send cooldown
    f = await bravo.flash(`${convoUrl}/reply`, { body: '[quote=Alpha]Meet at the bridge[/quote]\nRoger that.' });
    assert.match(f.page, /<cite>Alpha wrote:<\/cite>/);
    assert.equal(JSON.parse((await alpha.request('/notifications/poll?after=0', { headers: { accept: 'application/json' } })).text).messages, 1);

    // Live preview renders through the same parser, and needs the CSRF token.
    const token = await alpha.csrf();
    const prev = await alpha.request('/messages/preview', { method: 'POST', json: { body: '[i]draft[/i] <b>x</b>' }, headers: { 'x-csrf-token': token } });
    assert.equal(JSON.parse(prev.text).html, '<em>draft</em> &lt;b&gt;x&lt;/b&gt;');
    assert.equal((await alpha.request('/messages/preview', { method: 'POST', json: { body: 'x' } })).res.status, 403);

    // Strangers can't read a conversation.
    const charlie = await enlist('Charlie');
    assert.equal((await charlie.request(convoUrl)).res.status, 404);

    // Report: admins get a copy, then resolve it.
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run('Charlie');
    const msgId = db.prepare('SELECT id FROM messages WHERE sender_id = ?').get(id('Alpha')).id;
    assert.match((await bravo.flash(`/messages/report/${msgId}`, { reason: 'threats', back: convoUrl })).message, /sent to the moderators/);
    assert.match((await bravo.flash(`/messages/report/${msgId}`, { back: convoUrl })).message, /already reported/);
    assert.match((await alpha.flash(`/messages/report/${msgId}`, { back: convoUrl })).message, /your own message/);
    const reports = (await charlie.request('/admin/reports')).text;
    assert.match(reports, /Bravo<\/strong> reported a message from/);
    assert.match(reports, /<strong>Meet at the bridge<\/strong>/);
    assert.doesNotMatch(reports, /<script>alert/);
    assert.equal((await alpha.request('/admin/reports')).res.status, 404);
    const reportId = db.prepare('SELECT id FROM message_reports').get().id;
    await charlie.flash(`/admin/reports/${reportId}/resolve`, { resolution: 'actioned', note: 'warned' });
    assert.equal(db.prepare('SELECT status FROM message_reports').get().status, 'resolved');

    // Block: Alpha can't send to Bravo any more, in new or existing conversations.
    assert.match((await bravo.flash('/messages/block', { username: 'Alpha', back: convoUrl })).message, /Alpha is blocked/);
    db.prepare('UPDATE messages SET created_at = created_at - 10000').run();
    assert.match((await alpha.flash(`${convoUrl}/reply`, { body: 'hello?' })).message, /isn’t accepting messages/);
    assert.match((await alpha.flash('/messages', { to: 'Bravo', subject: 'Again', body: 'hi' })).message, /isn’t accepting messages/);
    assert.match((await bravo.request('/messages/blocked')).text, /Alpha/);
    await bravo.flash('/messages/unblock', { username: 'Alpha' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blocks').get().n, 0);

    // Deleting hides it for one side; once both delete, it's gone from the database.
    await alpha.flash(`${convoUrl}/hide`);
    assert.doesNotMatch((await alpha.request('/messages')).text, /Orders &lt;now&gt;/);
    assert.match((await bravo.request('/messages')).text, /Orders &lt;now&gt;/);
    await bravo.flash(`${convoUrl}/hide`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_reports').get().n, 1); // the report copy stays
  } finally {
    server.close();
  }
});
