/* GeneralForces client enhancements. Every page works without this script. */
(function () {
  'use strict';

  document.documentElement.classList.add('js');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Password visibility toggles ---------- */
  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    const input = document.getElementById(btn.dataset.togglePassword);
    if (!input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });

  /* ---------- Scroll reveals ---------- */
  const revealables = document.querySelectorAll('.reveal-on-scroll');
  if (revealables.length) {
    if (!('IntersectionObserver' in window) || reduceMotion) {
      revealables.forEach((el) => el.classList.add('is-visible'));
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          });
        },
        { rootMargin: '0px 0px -10% 0px' },
      );
      revealables.forEach((el) => io.observe(el));
    }
  }

  /* ---------- Bank forms: "All" shortcut and a live fee preview ---------- */
  document.querySelectorAll('[data-bank-form]').forEach((form) => {
    const input = form.querySelector('input[name="amount"]');
    const preview = form.querySelector('[data-preview]');
    const fee = Number(form.dataset.fee || 0);
    const max = Number(form.dataset.max || 0);
    const initial = preview.textContent;
    const money = (n) => `$${n.toLocaleString('en-US')}`;
    const update = () => {
      const n = Number(input.value.replace(/[$,\s]/g, ''));
      if (!input.value.trim() || !Number.isInteger(n) || n <= 0) { preview.textContent = initial; return; }
      if (n > max) { preview.textContent = `That's more than the ${money(max)} available.`; return; }
      if (fee) {
        const f = Math.max(1, Math.ceil(n * fee));
        preview.textContent = n <= f ? `Deposits must be more than the ${money(f)} fee.` : `${money(n - f)} will be banked after the ${money(f)} fee.`;
      }
    };
    input.addEventListener('input', update);
    form.querySelector('[data-fill-all]').addEventListener('click', () => {
      input.value = String(max);
      update();
      input.focus();
    });
  });

  /* ---------- Bounty form: show the total with the fee ---------- */
  document.querySelectorAll('[data-bounty-form]').forEach((form) => {
    const input = form.querySelector('input[name="amount"]');
    const preview = form.querySelector('[data-bounty-preview]');
    if (!input || !preview) return;
    const rate = Number(form.dataset.fee || 0);
    const initial = preview.textContent;
    input.addEventListener('input', () => {
      const n = Number(input.value.replace(/[$,\s]/g, ''));
      if (!input.value.trim() || !Number.isInteger(n) || n <= 0) { preview.textContent = initial; return; }
      const fee = Math.ceil(n * rate);
      preview.textContent = `Costs $${(n + fee).toLocaleString('en-US')} in total ($${fee.toLocaleString('en-US')} fee).`;
    });
  });

  /* ---------- Phone menu: close the "More" sheet on Escape or a tap outside ---------- */
  const more = document.querySelector('[data-tabbar-more]');
  if (more) {
    const sheet = more.querySelector('.tabbar__sheet');
    const summary = more.querySelector('summary');
    document.addEventListener('click', (e) => {
      if (more.open && !sheet.contains(e.target) && !summary.contains(e.target)) more.open = false;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && more.open) { more.open = false; summary.focus(); }
    });
    // Coming back with the browser's back button shouldn't leave the sheet open.
    window.addEventListener('pageshow', () => { more.open = false; });
  }

  /* ---------- Forms that ask before doing something drastic ---------- */
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });

  /* ---------- Selects that apply as soon as they change ---------- */
  document.querySelectorAll('select[data-autosubmit]').forEach((select) => {
    select.addEventListener('change', () => select.form && select.form.submit());
  });

  /* ---------- Countdowns to a timestamp (hospital release, builds, seasons) ---------- */
  const untils = document.querySelectorAll('[data-until]');
  if (untils.length) {
    let reloading = false;
    const tickUntil = () => {
      const now = Date.now();
      untils.forEach((el) => {
        const left = Math.max(0, Math.ceil((Number(el.dataset.until) - now) / 1000));
        const pad = (n) => String(n).padStart(2, '0');
        el.textContent = left <= 0 ? 'now'
          : left >= 86400 ? `${Math.floor(left / 86400)}d ${Math.floor(left / 3600) % 24}h` // days away: "27d 23h"
          : left >= 3600 ? `${Math.floor(left / 3600)}:${pad(Math.floor(left / 60) % 60)}:${pad(left % 60)}`
          : `${Math.floor(left / 60)}:${pad(left % 60)}`;
        if (left === 0 && el.hasAttribute('data-reload') && !reloading) {
          reloading = true;
          setTimeout(() => window.location.reload(), 1500);
        }
      });
    };
    tickUntil();
    setInterval(tickUntil, 1000);
  }

  /* ---------- Stat bar: live regen countdowns ---------- */
  const statbar = document.querySelector('[data-statbar]');
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  function setText(name, value) {
    document.querySelectorAll(`[data-stat="${name}"]`).forEach((el) => {
      const next = typeof value === 'number' ? value.toLocaleString('en-US') : value;
      if (el.textContent === next) return;
      el.textContent = next;
      const stat = el.closest('.stat');
      if (stat) {
        stat.classList.remove('is-bumped');
        void stat.offsetWidth; // restart animation
        stat.classList.add('is-bumped');
      }
    });
  }

  function setMeter(name, value, max) {
    const meter = document.querySelector(`[data-meter="${name}"]`);
    if (!meter) return;
    meter.setAttribute('aria-valuenow', value);
    meter.setAttribute('aria-valuemax', max);
    meter.firstElementChild.style.width = `${Math.floor((value / max) * 100)}%`;
  }

  const regen = {};
  function initRegen(key, next, interval) {
    regen[key] = { next: next === '' || next == null ? null : Number(next), interval: Number(interval) };
  }

  function renderPlayer(p) {
    setText('grade', p.grade);
    setText('rank', p.rank);
    setText('level', p.level);
    setText('energy', p.energy);
    setText('maxEnergy', p.maxEnergy);
    setText('health', p.health);
    setText('maxHealth', p.maxHealth);
    setText('cash', p.cash);
    if (p.bankBalance !== undefined) setText('bankBalance', p.bankBalance);
    setMeter('xp', p.xp, p.xpNeeded);
    setMeter('energy', p.energy, p.maxEnergy);
    setMeter('health', p.health, p.maxHealth);
    state.energy = p.energy;
    state.maxEnergy = p.maxEnergy;
    state.health = p.health;
    state.maxHealth = p.maxHealth;
    initRegen('energy', p.nextEnergyIn, p.energyRegenSeconds);
    initRegen('health', p.nextHealthIn, p.healthRegenSeconds);
  }

  const readNum = (name) => {
    const el = document.querySelector(`[data-stat="${name}"]`);
    return el ? Number(el.textContent.replace(/,/g, '')) : 0;
  };
  const state = {
    energy: readNum('energy'),
    maxEnergy: readNum('maxEnergy'),
    health: readNum('health'),
    maxHealth: readNum('maxHealth'),
  };

  if (statbar) {
    initRegen('energy', statbar.dataset.nextEnergy, statbar.dataset.energyInterval);
    initRegen('health', statbar.dataset.nextHealth, statbar.dataset.healthInterval);

    setInterval(() => {
      ['energy', 'health'].forEach((key) => {
        const r = regen[key];
        if (r.next === null) return;
        r.next -= 1;
        if (r.next <= 0) {
          const maxKey = key === 'energy' ? 'maxEnergy' : 'maxHealth';
          state[key] = Math.min(state[maxKey], state[key] + 1);
          setText(key, state[key]);
          setMeter(key, state[key], state[maxKey]);
          r.next = state[key] >= state[maxKey] ? null : r.interval;
          if (key === 'energy') refreshMissionAvailability();
        }
        document.querySelectorAll(`[data-countdown="${key}"]`).forEach((el) => {
          el.textContent = r.next === null ? 'full' : fmt(r.next);
        });
      });
    }, 1000);

    document.querySelectorAll('[data-countdown]').forEach((el) => {
      const r = regen[el.dataset.countdown];
      if (r && r.next !== null) el.textContent = fmt(r.next);
    });
  }

  /* ---------- Missions: launch without a full page reload ---------- */
  const resultBox = document.querySelector('[data-mission-result]');
  const missionData = new Map();

  // Energy regen can unblock missions that were greyed out for lack of energy.
  function refreshMissionAvailability() {
    document.querySelectorAll('[data-mission]').forEach((card) => {
      const btn = card.querySelector('button[type="submit"]');
      const blockerEl = card.querySelector('[data-blocker]');
      const cost = Number(card.querySelector('.mission__stats dd').textContent);
      if (!btn || !blockerEl || blockerEl.textContent !== 'Not enough energy') return;
      if (state.energy >= cost) {
        btn.disabled = false;
        blockerEl.textContent = '';
      }
    });
  }

  function applyMissionStates(missions) {
    missions.forEach((m) => {
      missionData.set(m.id, m);
      const card = document.querySelector(`[data-mission="${m.id}"]`);
      if (!card || m.locked) return;
      const btn = card.querySelector('button[type="submit"]');
      const blockerEl = card.querySelector('[data-blocker]');
      const chanceEl = card.querySelector('[data-chance]');
      if (btn) btn.disabled = Boolean(m.blocker);
      if (blockerEl) blockerEl.textContent = m.blocker || '';
      if (chanceEl) chanceEl.textContent = `${m.chancePct}%`;
    });
  }

  function showResult(data) {
    if (!resultBox) return;
    const r = data.result;
    resultBox.className = 'mission-result';
    resultBox.replaceChildren();
    const tag = document.createElement('span');
    tag.className = 'mission-result__tag';
    const text = document.createElement('p');
    text.className = 'mission-result__text';
    const strong = document.createElement('strong');

    if (!data.ok) {
      resultBox.classList.add('mission-result--failure');
      tag.textContent = 'Denied';
      strong.textContent = data.error || 'Mission could not be launched.';
      text.append(strong);
    } else {
      resultBox.classList.add(r.success ? 'mission-result--success' : 'mission-result--failure');
      tag.textContent = r.success ? 'Success' : 'Failed';
      strong.textContent = r.missionName;
      text.append(
        strong,
        r.success
          ? ` — objective secured. +${r.xp} XP, +$${r.cash}.`
          : ` — mission failed. You took ${r.damage} damage${r.absorbed ? ` (armour absorbed ${r.absorbed})` : ''} but earned ${r.xp} XP.`,
      );
      if (r.levelsGained.length) {
        const promo = document.createElement('span');
        promo.className = 'mission-result__promo';
        promo.textContent = `Promotion! You are now ${data.player.rank}, level ${data.player.level}.`;
        text.append(promo);
      }
    }
    resultBox.append(tag, text);
    resultBox.hidden = false;
  }

  document.querySelectorAll('[data-mission-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      if (!window.fetch) return;
      event.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      const card = form.closest('[data-mission]');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      const label = btn.textContent;
      btn.textContent = 'Launching…';

      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form)),
          credentials: 'same-origin',
        });
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        const data = await res.json();
        if (data.player) renderPlayer(data.player);
        showResult(data);
        if (data.missions) applyMissionStates(data.missions);
        if (data.missions && data.missions.some((m) => !m.locked && !document.querySelector(`[data-mission="${m.id}"] button[type="submit"]`))) {
          // A mission unlocked from a promotion; reload to render its card.
          setTimeout(() => window.location.reload(), 2500);
        }
        if (card && data.result && !reduceMotion) {
          card.classList.remove('is-hit', 'is-miss');
          void card.offsetWidth;
          card.classList.add(data.result.success ? 'is-hit' : 'is-miss');
        }
      } catch (err) {
        form.submit(); // network hiccup: fall back to a normal post
        return;
      } finally {
        btn.textContent = label;
        btn.removeAttribute('aria-busy');
      }
      const entry = missionData.get(card && card.dataset.mission);
      btn.disabled = Boolean(entry && entry.blocker);
    });
  });

  /* ---------- BBCode editor: toolbar, shortcuts, preview, counter ---------- */
  document.querySelectorAll('[data-bb-editor]').forEach((editor) => {
    const ta = editor.querySelector('textarea');
    if (!ta || typeof ta.setRangeText !== 'function') return;
    editor.classList.add('is-enhanced');
    const counter = editor.querySelector('[data-bb-count]');
    const previewPane = editor.querySelector('[data-bb-preview]');
    const max = Number(ta.getAttribute('maxlength')) || 5000;
    const changed = () => ta.dispatchEvent(new Event('input', { bubbles: true }));

    // Wraps the selection in a tag pair; with nothing selected, inserts the
    // pair around a placeholder and selects it so typing replaces it.
    const wrap = (open, close, placeholder = '') => {
      const { selectionStart: s, selectionEnd: e, value } = ta;
      const selected = value.slice(s, e);
      const inner = selected || placeholder;
      ta.setRangeText(open + inner + close, s, e, 'end');
      if (!selected) ta.setSelectionRange(s + open.length, s + open.length + inner.length);
      ta.focus();
      changed();
    };
    const insert = (text) => {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.focus();
      changed();
    };

    const actions = {
      b: () => wrap('[b]', '[/b]', 'bold text'),
      i: () => wrap('[i]', '[/i]', 'italic text'),
      u: () => wrap('[u]', '[/u]', 'underlined text'),
      s: () => wrap('[s]', '[/s]', 'struck text'),
      center: () => wrap('[center]', '[/center]', 'centred text'),
      quote: () => wrap('[quote]', '[/quote]', 'quoted text'),
      code: () => wrap('[code]', '[/code]', 'code'),
      spoiler: () => wrap('[spoiler]', '[/spoiler]', 'hidden text'),
      hr: () => insert('\n[hr]\n'),
      player: () => {
        const name = window.prompt('Callsign of the player to link:', ta.value.slice(ta.selectionStart, ta.selectionEnd));
        if (name) insert(`[player]${name.trim()}[/player]`);
      },
      url: () => {
        const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        const href = window.prompt('Link address (must start with https:// or http://):', /^https?:\/\//.test(selected) ? selected : 'https://');
        if (!href || href === 'https://') return;
        if (selected && selected !== href) insert(`[url=${href.trim()}]${selected}[/url]`);
        else insert(`[url]${href.trim()}[/url]`);
      },
      list: () => {
        const { selectionStart: s, selectionEnd: e, value } = ta;
        const lines = value.slice(s, e).split('\n').filter((l) => l.trim());
        const items = (lines.length ? lines : ['First item', 'Second item']).map((l) => `[*]${l.trim()}`).join('\n');
        ta.setRangeText(`[list]\n${items}\n[/list]`, s, e, 'end');
        ta.focus();
        changed();
      },
    };

    editor.querySelectorAll('[data-bb]').forEach((btn) => {
      btn.addEventListener('click', () => { const fn = actions[btn.dataset.bb]; if (fn) fn(); });
    });
    editor.querySelectorAll('[data-bb-color]').forEach((btn) => {
      btn.addEventListener('click', () => wrap(`[color=${btn.dataset.bbColor}]`, '[/color]', 'coloured text'));
    });
    const size = editor.querySelector('[data-bb-size]');
    if (size) size.addEventListener('change', () => { if (size.value) wrap(`[size=${size.value}]`, '[/size]', 'text'); size.value = ''; });

    ta.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (['b', 'i', 'u'].includes(key)) { e.preventDefault(); actions[key](); }
      if (key === 'enter' && ta.form) { e.preventDefault(); ta.form.requestSubmit(); }
    });

    const count = () => {
      if (!counter) return;
      const n = ta.value.length;
      counter.textContent = `${n.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`;
      counter.classList.toggle('is-over', n > max * 0.95);
    };
    ta.addEventListener('input', count);
    count();

    // Write / Preview tabs. The preview is rendered by the server, so it's
    // exactly what the recipient will see.
    const tabs = editor.querySelectorAll('[data-bb-tab]');
    const show = async (which) => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.bbTab === which)));
      editor.classList.toggle('is-previewing', which === 'preview');
      if (which !== 'preview' || !previewPane) { ta.focus(); return; }
      previewPane.textContent = 'Loading preview…';
      try {
        const token = ta.form && ta.form.querySelector('input[name="_csrf"]');
        const res = await fetch(editor.dataset.previewUrl || '/format/preview', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': token ? token.value : '' },
          body: JSON.stringify({ body: ta.value }),
        });
        const data = await res.json();
        // The server returns HTML built only from escaped text and allowlisted tags.
        previewPane.innerHTML = data.html || '<p class="muted">Nothing to preview yet.</p>';
      } catch (err) {
        previewPane.textContent = 'Couldn’t load the preview. Check your connection.';
      }
    };
    tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.bbTab)));
  });

  // "Quote" on a message drops it into the reply box.
  document.querySelectorAll('[data-bb-quote]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ta = document.querySelector(btn.dataset.bbQuote);
      if (!ta) return;
      // Leave out quotes inside the quoted message so replies don't nest forever.
      const body = btn.dataset.body.replace(/\[quote(=[^\]]*)?\][\s\S]*?\[\/quote\]\n?/gi, '').trim();
      const text = `[quote=${btn.dataset.author}]${body}[/quote]\n`;
      ta.value = ta.value ? `${ta.value.replace(/\s*$/, '')}\n${text}` : text;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });

  /* ---------- Live notifications: poll, update the bell, pop up toasts ---------- */
  const bell = document.querySelector('[data-bell]');
  const toasts = document.querySelector('[data-toasts]');
  if (bell && toasts && window.fetch) {
    const POLL_MS = 20000;
    const POLL_HIDDEN_MS = 60000;
    const MAX_TOASTS = 3;
    let latestId = Number(bell.dataset.latestId) || 0;
    let polling = false;
    const mail = document.querySelector('[data-mail]');
    let mailCount = mail ? Number(mail.dataset.count) || 0 : 0;

    const setMail = (n) => {
      if (!mail) return;
      const badge = mail.querySelector('[data-mail-count]');
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = n === 0;
      mail.setAttribute('aria-label', n ? `Messages, ${n} unread` : 'Messages');
    };

    // Chat icon: a count for your unit channel, a dot when Global has news. The chat page keeps itself read.
    const chatBell = document.querySelector('[data-chat-bell]');
    // Start from the @ badge as the server rendered it, so the title is right before the first poll.
    const atBadge = chatBell && chatBell.querySelector('[data-chat-mention]');
    let mentionCount = atBadge && !atBadge.hidden ? Number(atBadge.textContent.replace(/\D/g, '')) || 1 : 0;
    const setChat = (c) => {
      if (!chatBell || !c) return;
      const count = chatBell.querySelector('[data-chat-count]');
      const dot = chatBell.querySelector('[data-chat-dot]');
      const at = chatBell.querySelector('[data-chat-mention]');
      const m = c.mentions || { global: 0, unit: 0 };
      mentionCount = m.global + m.unit;
      if (at) {
        at.textContent = mentionCount > 1 ? `@${mentionCount > 9 ? '9+' : mentionCount}` : '@';
        at.hidden = !mentionCount;
      }
      chatBell.classList.toggle('is-mentioned', mentionCount > 0);
      count.textContent = c.unit > 99 ? '99+' : String(c.unit);
      count.hidden = !c.unit || mentionCount > 0;
      dot.hidden = mentionCount > 0 || Boolean(c.unit) || !c.global;
      chatBell.setAttribute('href', m.unit ? '/chat/unit' : m.global ? '/chat/global' : c.unit ? '/chat/unit' : '/chat');
      chatBell.setAttribute('aria-label', mentionCount ? `Chat, you were mentioned${mentionCount > 1 ? ` ${mentionCount} times` : ''}`
        : c.unit ? `Chat, ${c.unit} new in your unit channel` : c.global ? 'Chat, new messages' : 'Chat');
    };

    // The tab title carries a count, so a mention or attack shows in a background tab.
    const baseTitle = document.title.replace(/^\(\d+\+?\) /, '');
    let bellCount = Number((bell.querySelector('[data-bell-count]') || {}).textContent) || 0;
    const setTitle = () => {
      const n = bellCount + mentionCount;
      document.title = n ? `(${n > 99 ? '99+' : n}) ${baseTitle}` : baseTitle;
    };

    const setCount = (n) => {
      bellCount = n;
      const badge = bell.querySelector('[data-bell-count]');
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = n === 0;
      bell.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
    };

    const toast = (item) => {
      const el = document.createElement('div');
      el.className = `toast toast--${item.kind}`;
      el.setAttribute('role', 'status');
      const msg = document.createElement('p');
      msg.className = 'toast__msg';
      msg.textContent = item.message;
      el.append(msg);
      if (item.link) {
        const a = document.createElement('a');
        a.href = item.link;
        a.textContent = item.link.startsWith('/battles') ? 'View report' : item.kind === 'chat' ? 'Go to message' : 'Take a look';
        el.append(a);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast__close';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.addEventListener('click', () => el.remove());
      el.append(close);
      toasts.append(el);
      setTimeout(() => el.classList.add('is-leaving'), 12000);
      setTimeout(() => el.remove(), 12600);
    };

    let lastPoll = 0;
    const poll = async () => {
      // Background tabs check less often, so the title and desktop alerts still update.
      if (polling || (document.hidden && Date.now() - lastPoll < POLL_HIDDEN_MS)) return;
      lastPoll = Date.now();
      polling = true;
      try {
        // `visible` tells the server you're playing, so it holds back push alerts to your phone.
        const res = await fetch(`/notifications/poll?after=${latestId}${document.hidden ? '' : '&visible=1'}`, {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const data = await res.json();
        setCount(data.unread);
        if (!location.pathname.startsWith('/chat')) setChat(data.chat);
        if (typeof data.messages === 'number') {
          if (data.messages > mailCount && !location.pathname.startsWith('/messages')) {
            toast({ kind: 'message', message: data.messages === 1 ? 'You have a new private message.' : `You have ${data.messages} unread conversations.`, link: '/messages' });
          }
          mailCount = data.messages;
          setMail(mailCount);
        }
        setTitle();
        if (data.items.length) {
          latestId = data.latestId;
          // A mention in the channel you're reading is already on screen.
          const shown = data.items.filter((i) => !(i.kind === 'chat' && i.link && i.link.split('#')[0] === location.pathname));
          shown.slice(-MAX_TOASTS).forEach(toast);
          if (shown.length > MAX_TOASTS) {
            toast({ kind: 'system', message: `+${shown.length - MAX_TOASTS} more`, link: '/notifications' });
          }
          // Someone may have just changed our health or cash: refresh the stat bar.
          if (statbar && data.player) renderPlayer(data.player);
          if (data.player && data.player.hospitalized && !document.querySelector('.ward-banner')) {
            toast({ kind: 'attacked-lost', message: 'You’re in hospital. Missions and PvP are paused.', link: '/hospital' });
          }
        }
      } catch (err) {
        /* offline or server restarting: try again next tick */
      } finally {
        polling = false;
      }
    };

    setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastPoll = 0; poll(); } });
    setTitle();
  }
  /* ---------- Chat: live updates, send without reloading, Enter to send ---------- */
  const chatBox = document.querySelector('[data-chat]');
  if (chatBox) {
    const win = chatBox.querySelector('.chat__window');
    const list = chatBox.querySelector('[data-chat-list]');
    const empty = chatBox.querySelector('[data-chat-empty]');
    const form = chatBox.querySelector('[data-chat-form]');
    const errorEl = chatBox.querySelector('[data-chat-error]');
    const paused = list.hasAttribute('data-chat-paused'); // reading older history: no live updates
    const token = (form || document).querySelector('input[name="_csrf"]');

    const localTimes = (root) => root.querySelectorAll('[data-local-time]').forEach((el) => {
      const d = new Date(el.getAttribute('datetime'));
      if (!Number.isNaN(d.getTime())) el.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    const nearBottom = () => win.scrollHeight - win.scrollTop - win.clientHeight < 90;
    const toBottom = () => { win.scrollTop = win.scrollHeight; };
    const lastId = () => { const items = list.querySelectorAll('.chat-msg'); return items.length ? Number(items[items.length - 1].dataset.id) : 0; };
    const syncEmpty = () => { if (empty) empty.hidden = list.children.length > 0; };
    const add = (rows) => {
      const stick = nearBottom();
      for (const r of rows) {
        if (document.getElementById(`m-${r.id}`)) continue;
        // Server-rendered partial: escaped text plus allowlisted BBCode tags only.
        list.insertAdjacentHTML('beforeend', r.html);
        localTimes(list.lastElementChild);
      }
      syncEmpty();
      if (stick) toBottom();
    };

    localTimes(list);
    const target = location.hash.startsWith('#m-') && document.getElementById(location.hash.slice(1));
    if (target) {
      target.classList.add('is-target');
      win.scrollTop = target.offsetTop - win.offsetTop - 40;
    } else if (!paused) toBottom();

    let busy = false;
    const poll = async () => {
      if (busy || paused) return;
      busy = true;
      try {
        const res = await fetch(`${chatBox.dataset.pollUrl}?after=${lastId()}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (res.ok) {
          const data = await res.json();
          add(data.messages || []);
          for (const id of data.deleted || []) { const el = document.getElementById(`m-${id}`); if (el) el.remove(); }
          syncEmpty();
        }
      } catch (err) {
        /* offline: try again next tick */
      } finally {
        busy = false;
      }
    };
    let timer = null;
    const schedule = () => { clearInterval(timer); timer = setInterval(poll, document.hidden ? 20000 : 4000); };
    schedule();
    document.addEventListener('visibilitychange', () => { schedule(); if (!document.hidden) poll(); });

    if (form) {
      const ta = form.querySelector('textarea');
      const showError = (msg) => { errorEl.textContent = msg || ''; errorEl.hidden = !msg; };
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!ta.value.trim()) return;
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          const res = await fetch(form.action, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(new FormData(form)),
            credentials: 'same-origin',
          });
          if (res.status === 401) { window.location.href = '/login'; return; }
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) { showError(data.error || 'Couldn’t send. Try again.'); return; }
          showError('');
          ta.value = '';
          ta.dispatchEvent(new Event('input', { bubbles: true })); // refresh the character count
          add([data]);
          toBottom();
        } catch (err) {
          showError('Couldn’t reach the server. Check your connection.');
        } finally {
          btn.disabled = false;
          ta.focus();
        }
      });
      // Enter sends; Shift+Enter adds a new line.
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
    }

    // Deleting a message takes it off the screen straight away.
    list.addEventListener('submit', async (e) => {
      const del = e.target.closest('[data-chat-delete]');
      if (!del) return;
      e.preventDefault();
      const item = del.closest('.chat-msg');
      try {
        const res = await fetch(del.action, {
          method: 'POST',
          headers: { Accept: 'application/json', 'X-CSRF-Token': token ? token.value : '' },
          body: new URLSearchParams(new FormData(del)),
          credentials: 'same-origin',
        });
        if (res.ok && item) item.remove();
        syncEmpty();
      } catch (err) { del.submit(); }
    });

    // One message menu open at a time; a tap elsewhere closes it.
    document.addEventListener('click', (e) => {
      for (const d of chatBox.querySelectorAll('.chat-msg__menu[open]')) if (!d.contains(e.target)) d.open = false;
    });
  }
  /* ---------- Avatar badge builder: live preview and shuffle ---------- */
  const builder = document.querySelector('[data-avatar-builder]');
  if (builder) {
    const preview = builder.querySelector('[data-avatar-preview]');
    const note = builder.querySelector('.avatar-builder__note');
    builder.querySelectorAll('[data-avatar-nojs]').forEach((el) => { el.hidden = true; });
    const update = () => {
      const params = new URLSearchParams();
      for (const [k, v] of new FormData(builder)) if (k !== '_csrf') params.set(k, v);
      preview.src = `/avatars/preview?${params}`;
      if (note) note.textContent = 'Preview: press Save badge to keep it.';
    };
    builder.addEventListener('change', update);
    // The preview sticks just below the (sticky) site header, whatever its height.
    const header = document.querySelector('.site-header');
    const setHeaderHeight = () => {
      const sticky = header && getComputedStyle(header).position === 'sticky';
      document.documentElement.style.setProperty('--header-h', `${sticky ? header.offsetHeight : 0}px`);
    };
    setHeaderHeight();
    window.addEventListener('resize', setHeaderHeight);
    const shuffle = builder.querySelector('[data-avatar-random]');
    if (shuffle) {
      shuffle.hidden = false;
      shuffle.addEventListener('click', () => {
        const groups = new Map();
        builder.querySelectorAll('input[type="radio"]:not(:disabled)').forEach((r) => {
          if (!groups.has(r.name)) groups.set(r.name, []);
          groups.get(r.name).push(r);
        });
        for (const list of groups.values()) list[Math.floor(Math.random() * list.length)].checked = true;
        update();
      });
    }
  }

  /* ---------- Avatar upload: catch oversized files before sending ---------- */
  document.querySelectorAll('[data-avatar-upload]').forEach((form) => {
    const input = form.querySelector('input[type="file"]');
    const hint = form.querySelector('[data-avatar-upload-hint]');
    const max = Number(form.dataset.maxBytes) || 0;
    const original = hint ? hint.textContent : '';
    const check = () => {
      const file = input.files && input.files[0];
      const tooBig = Boolean(file && max && file.size > max);
      const badType = Boolean(file && !/^image\/(png|jpeg|webp)$/.test(file.type));
      if (hint) {
        hint.textContent = tooBig ? `That picture is ${Math.ceil(file.size / 1024).toLocaleString()} KB. The limit is ${Math.round(max / 1024).toLocaleString()} KB.`
          : badType ? 'Use a PNG, JPEG or WebP picture.' : original;
        hint.classList.toggle('is-error', tooBig || badType);
      }
      return !(tooBig || badType);
    };
    input.addEventListener('change', check);
    form.addEventListener('submit', (e) => { if (!check()) e.preventDefault(); });
  });
  /* ---------- Installable app: service worker, install button, offline page ---------- */
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* the game works without it */ });
  }
  if (document.body.classList.contains('page-offline')) {
    window.addEventListener('online', () => location.reload());
  }
  const installBtn = document.querySelector('[data-install]');
  if (installBtn) {
    if (standalone) {
      document.querySelector('[data-install-text]').hidden = true;
      document.querySelector('[data-install-done]').hidden = false;
    }
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      installBtn.hidden = false;
      // One tap does it, so the step-by-step instructions aren't needed.
      document.querySelector('[data-install-text]').textContent = 'Install GeneralForces like an app: its own icon, full screen, no browser bars.';
    });
    installBtn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice.catch(() => null);
      deferred = null;
      installBtn.hidden = true;
    });
    window.addEventListener('appinstalled', () => { installBtn.hidden = true; });
  }

  /* ---------- App & alerts page: push notifications on this device ---------- */
  const tzInput = document.querySelector('[data-tz]');
  const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (err) { return ''; } })();
  if (tzInput && zone) {
    tzInput.value = zone;
    const label = document.querySelector('[data-tz-label]');
    if (label) label.textContent = zone;
  }
  const pushBox = document.querySelector('[data-push]');
  if (pushBox) {
    const status = pushBox.querySelector('[data-push-status]');
    const toggle = pushBox.querySelector('[data-push-toggle]');
    const csrfInput = document.querySelector('input[name="_csrf"]');
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
    const keyBytes = (b64) => {
      const pad = '='.repeat((4 - (b64.length % 4)) % 4);
      const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
      return Uint8Array.from(raw, (c) => c.charCodeAt(0));
    };
    const post = (url, body) => fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfInput ? csrfInput.value : '' },
      body: JSON.stringify(body),
    });
    const say = (text) => { status.textContent = text; };

    const render = async () => {
      if (!supported) {
        return say(isIos && !standalone
          ? 'On iPhone and iPad, alerts work from the installed app: add GeneralForces to your Home Screen (see above), open it from there, then turn alerts on here.'
          : 'This browser doesn’t support push alerts. Try Chrome, Edge, Firefox or Safari.');
      }
      if (Notification.permission === 'denied') {
        toggle.hidden = true;
        return say('Your browser is blocking notifications from GeneralForces. Allow them in the browser’s site settings (or your phone’s app settings), then reload this page.');
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const listed = sub && [...document.querySelectorAll('[data-endpoint]')].find((el) => el.dataset.endpoint === sub.endpoint);
      if (sub && !listed) {
        // Subscribed in this browser but unknown to the server (e.g. removed from another device): re-register.
        await post('/push/subscribe', { subscription: sub.toJSON(), tz: zone });
      }
      if (listed) { const tag = listed.querySelector('[data-this-device]'); if (tag) tag.hidden = false; }
      toggle.hidden = false;
      toggle.textContent = sub ? 'Turn off alerts' : 'Turn on alerts';
      toggle.classList.toggle('btn--primary', !sub);
      toggle.classList.toggle('btn--ghost', Boolean(sub));
      say(sub ? 'Alerts are on for this device.' : 'Alerts are off for this device. Turn them on to hear about mentions, attacks and more while you’re away.');
      return sub;
    };

    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        const reg = await navigator.serviceWorker.ready;
        const current = await reg.pushManager.getSubscription();
        if (current) {
          await post('/push/unsubscribe', { endpoint: current.endpoint });
          await current.unsubscribe();
        } else {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') { await render(); return; }
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushBox.dataset.publicKey) });
          const res = await post('/push/subscribe', { subscription: sub.toJSON(), tz: zone });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            await sub.unsubscribe();
            say(data.error || 'Couldn’t turn alerts on. Try again in a moment.');
            return;
          }
        }
        location.reload(); // show the updated device list
      } catch (err) {
        say('Couldn’t change alerts on this device. Try again, or check the browser’s notification settings.');
      } finally {
        toggle.disabled = false;
      }
    });
    render().catch(() => say('Couldn’t check alerts on this device.'));
  }
})();
