/* EliteForces client enhancements. Every page works without this script. */
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

  /* ---------- Countdowns to a timestamp (hospital release) ---------- */
  const untils = document.querySelectorAll('[data-until]');
  if (untils.length) {
    let reloading = false;
    const tickUntil = () => {
      const now = Date.now();
      untils.forEach((el) => {
        const left = Math.max(0, Math.ceil((Number(el.dataset.until) - now) / 1000));
        el.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'now';
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

  /* ---------- Missions: deploy without a full page reload ---------- */
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
      btn.textContent = 'Deploying…';

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
})();
