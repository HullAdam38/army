'use strict';

const crypto = require('node:crypto');
const bj = require('./blackjack');
const game = require('./game');
const tuning = require('./tuning');
const { createCasinoPlayer } = require('./casino-player');

const SEATS = 5;
const BET_MS = 15 * 1000; // the betting window once someone bets
const TURN_MS = 20 * 1000; // each hand's time to act before it stands
const DONE_MS = 6 * 1000; // results stay up before the next round
const IDLE_MS = 2 * 60 * 1000; // seated players who stop looking at the table leave between rounds
const MAX_SKIPPED_ROUNDS = 5; // …and so do players who sit out this many rounds in a row
const LOG_LINES = 12;

const TABLES = [
  { id: 1, name: 'Mess Hall', min: 10, max: 500, blurb: 'Low stakes. A good place to learn.' },
  { id: 2, name: 'Officers’ Lounge', min: 100, max: 5000, blurb: 'Mid stakes for seasoned players.' },
  { id: 3, name: 'War Room', min: 1000, max: Infinity, blurb: 'High stakes, up to the casino’s blackjack limit.' },
];
const TABLES_BY_ID = new Map(TABLES.map((t) => [t.id, t]));

/**
 * Multiplayer blackjack: shared tables against the house. Each table's state
 * (seats, hands, the dealer and the shoe) lives in memory and is saved to
 * blackjack_tables after every change, so a restart picks up mid-round. All
 * changes run inside players.transaction (the caller's, or tick()'s own).
 *
 * Money: a bet, double or split takes cash at once (ledger reason
 * casino-blackjack); winnings are paid at the end of the round. Players only
 * ever play against the house, so no value can pass between them.
 */
function createBlackjackService(db, players, { randomInt = crypto.randomInt, casinoPlayer = createCasinoPlayer(db) } = {}) {
  const stmts = {
    load: db.prepare('SELECT state FROM blackjack_tables WHERE id = ?'),
    save: db.prepare(`INSERT INTO blackjack_tables (id, state, updated_at) VALUES (?, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`),
    play: db.prepare('INSERT INTO casino_plays (user_id, game, bet, payout, mult, result, created_at, variance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    user: db.prepare('SELECT id, username, avatar_v FROM users WHERE id = ?'),
  };

  const fresh = (id) => ({ id, version: 0, phase: 'idle', round: 0, deadline: null, shoe: [], seats: Array(SEATS).fill(null), dealer: [], turn: null, log: [] });
  const states = new Map();
  for (const t of TABLES) {
    const row = stmts.load.get(t.id);
    states.set(t.id, row ? JSON.parse(row.state) : fresh(t.id));
  }

  const limitsOf = (table) => ({ min: table.min, max: Math.min(table.max, tuning.get('blackjackMaxBet')) });
  const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
  const save = (s, now) => {
    s.version += 1;
    stmts.save.run(s.id, JSON.stringify(s), now);
  };
  const log = (s, text) => {
    s.log.push(text);
    if (s.log.length > LOG_LINES) s.log.splice(0, s.log.length - LOG_LINES);
  };
  const draw = (s) => {
    if (!s.shoe.length) s.shoe = bj.newShoe(randomInt);
    return s.shoe.pop();
  };
  const seatOf = (s, userId) => s.seats.findIndex((seat) => seat && seat.userId === userId);
  const tableOf = (userId) => [...states.values()].find((s) => seatOf(s, userId) >= 0) || null;
  const payCash = (userId, delta, s, now) => {
    const found = players.findById(userId);
    if (!found) return null; // the account is gone; nothing to pay
    const p = game.applyRegen(found, now);
    p.cash += delta;
    players.save(p, { reason: 'casino-blackjack', ref: `bj:${s.id}:${s.round}` });
    return p;
  };

  /** Why `player` can't play, or null. */
  function blocker(player) {
    if (!tuning.get('casinoOpen')) return 'The casino is closed for now. Check back later.';
    const min = tuning.get('casinoMinLevel');
    if (player.level < min) return `The casino opens at level ${min}.`;
    return casinoPlayer.breakBlocker(player);
  }

  // Bets on the table count towards the player's loss limit until the round is settled.
  casinoPlayer.trackInPlay((userId) => {
    const s = tableOf(userId);
    if (!s || s.phase === 'done') return 0;
    const seat = s.seats[seatOf(s, userId)];
    return s.phase === 'playing' ? (seat.hands || []).reduce((n, h) => n + h.bet, 0) : seat.bet;
  });
  /** Cash the player can put on a double or split: what they carry, within their loss limit. */
  const stakeable = (player, now) => Math.min(player.cash, casinoPlayer.room(player.id, now));

  // ---- The round ----

  function deal(s, now) {
    if (bj.needsShuffle(s.shoe)) {
      s.shoe = bj.newShoe(randomInt);
      log(s, 'The dealer shuffles a new shoe.');
    }
    s.round += 1;
    s.dealer = [];
    const playing = [];
    s.seats.forEach((seat, i) => {
      if (!seat) return;
      if (seat.bet > 0 && !seat.leaving) {
        seat.hands = [{ cards: [], bet: seat.bet, doubled: false, split: false, done: false }];
        seat.skipped = 0;
        playing.push(i);
      } else {
        seat.hands = [];
        seat.skipped = (seat.skipped || 0) + 1;
      }
    });
    for (let round = 0; round < 2; round += 1) {
      for (const i of playing) s.seats[i].hands[0].cards.push(draw(s));
      s.dealer.push(draw(s));
    }
    for (const i of playing) if (bj.isBlackjack(s.seats[i].hands[0].cards)) s.seats[i].hands[0].done = true;
    s.phase = 'playing';
    log(s, `Round ${s.round}: cards are dealt.`);
    if (bj.dealerPeeks(s.dealer[0]) && bj.isBlackjack(s.dealer)) {
      log(s, 'The dealer has blackjack.');
      return finish(s, now);
    }
    s.turn = null;
    return next(s, now);
  }

  /** Moves to the next hand that still has to act, or finishes the round. */
  function next(s, now) {
    const start = s.turn ? { seat: s.turn.seat, hand: s.turn.hand + 1 } : { seat: 0, hand: 0 };
    for (let i = start.seat; i < SEATS; i += 1) {
      const seat = s.seats[i];
      if (!seat || !seat.hands) continue;
      for (let h = i === start.seat ? start.hand : 0; h < seat.hands.length; h += 1) {
        const hand = seat.hands[h];
        if (hand.done) continue;
        if (seat.leaving) { hand.done = true; continue; } // gone: the hand stands
        s.turn = { seat: i, hand: h };
        s.deadline = now + TURN_MS;
        return;
      }
    }
    finish(s, now);
  }

  /** The dealer plays and every hand is settled and paid. */
  function finish(s, now) {
    s.turn = null;
    const live = s.seats.some((seat) => seat && seat.hands && seat.hands.some((h) => !bj.isBust(h.cards) && !(bj.isBlackjack(h.cards) && !h.split)));
    if (live && !bj.isBlackjack(s.dealer)) bj.dealerPlay(s.dealer, () => draw(s));
    const d = bj.handValue(s.dealer).total;
    log(s, `Dealer ${bj.isBlackjack(s.dealer) ? 'has blackjack' : d > 21 ? `busts with ${d}` : `stands on ${d}`}.`);
    for (const seat of s.seats) {
      if (!seat || !seat.hands || !seat.hands.length) continue;
      let staked = 0;
      let paid = 0;
      for (const hand of seat.hands) {
        Object.assign(hand, bj.settleHand(hand, s.dealer));
        staked += hand.bet;
        paid += hand.payout;
      }
      if (paid) payCash(seat.userId, paid, s, now);
      const result = { table: s.id, round: s.round, dealer: s.dealer, hands: seat.hands.map((h) => ({ cards: h.cards, bet: h.bet, result: h.result })) };
      const variance = seat.hands.reduce((n, h) => n + h.bet * h.bet * bj.VARIANCE, 0);
      stmts.play.run(seat.userId, 'blackjack', staked, paid, Math.round((paid / staked) * 100) / 100, JSON.stringify(result), now, variance);
      const naturals = seat.hands.filter((h) => h.result === 'blackjack').length;
      casinoPlayer.record({ userId: seat.userId, username: seat.username, game: 'blackjack', bet: staked, payout: paid, blackjacks: naturals, detail: naturals ? 'a blackjack' : null, now });
      const net = paid - staked;
      log(s, `${seat.username}: ${seat.hands.map((h) => bj.RESULT_LABEL[h.result]).join(' / ')} (${net >= 0 ? '+' : '−'}${money(Math.abs(net))}).`);
    }
    s.phase = 'done';
    s.deadline = now + DONE_MS;
  }

  /** Clears the table for the next round, standing up anyone who left or went quiet. */
  function reset(s, now) {
    s.seats = s.seats.map((seat) => {
      if (!seat) return null;
      const gone = seat.leaving || now - seat.lastSeen > IDLE_MS || (seat.skipped || 0) >= MAX_SKIPPED_ROUNDS;
      if (gone) {
        if (!seat.leaving) log(s, `${seat.username} left the table.`);
        return null;
      }
      return { ...seat, bet: 0, hands: [] };
    });
    s.dealer = [];
    s.turn = null;
    s.phase = 'idle';
    s.deadline = null;
  }

  /** Advances one table past any deadline that has passed. Returns true if it changed. */
  function advance(s, now) {
    let changed = false;
    for (let guard = 0; guard < 20 && s.deadline && s.deadline <= now; guard += 1) {
      changed = true;
      if (s.phase === 'betting') deal(s, now);
      else if (s.phase === 'playing' && s.turn) {
        const seat = s.seats[s.turn.seat];
        seat.hands[s.turn.hand].done = true;
        log(s, `${seat.username} ran out of time and stands.`);
        next(s, now);
      } else if (s.phase === 'done') reset(s, now);
      else s.deadline = null;
    }
    // Between rounds, quiet players give up their seats.
    if (s.phase === 'idle') {
      for (let i = 0; i < SEATS; i += 1) {
        const seat = s.seats[i];
        if (seat && now - seat.lastSeen > IDLE_MS) {
          s.seats[i] = null;
          log(s, `${seat.username} left the table.`);
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Runs `fn(state, player)` for a seated player, saving if it succeeds. */
  function withTable(tableId, now, fn) {
    const s = states.get(Number(tableId));
    if (!s) return { error: 'That table doesn’t exist.' };
    return guarded(s, () => {
      if (advance(s, now)) save(s, now);
      const out = fn(s) || {};
      if (!out.error) save(s, now);
      return out;
    });
  }

  /**
   * Runs a change to table `s`. The state lives in memory, but money and the
   * saved copy are in the database: if anything throws, the caller's
   * transaction rolls those back, so the in-memory table goes back to what was
   * last saved too. Otherwise a failed payout could leave a round marked paid.
   */
  function guarded(s, fn) {
    const before = JSON.stringify(s);
    try {
      return fn();
    } catch (err) {
      states.set(s.id, JSON.parse(before));
      throw err;
    }
  }

  return {
    TABLES,
    SEATS,
    limitsOf: (tableId) => limitsOf(TABLES_BY_ID.get(Number(tableId))),
    blocker,
    tableOf: (userId) => { const s = tableOf(userId); return s ? s.id : null; },

    /** Lobby rows: every table with its stakes and who's sitting there. */
    lobby(now = Date.now()) {
      return TABLES.map((t) => {
        const s = states.get(t.id);
        const seated = s.seats.filter(Boolean);
        return { ...t, ...limitsOf(t), seated: seated.length, seats: SEATS, names: seated.map((x) => x.username), phase: s.phase, live: Boolean(s.deadline && s.deadline > now) };
      });
    },

    sit({ tableId, userId, seat: seatIndex, now = Date.now() }) {
      return withTable(tableId, now, (s) => {
        const player = players.findById(userId);
        const why = blocker(player);
        if (why) return { error: why };
        const other = tableOf(userId);
        if (other && other.id === s.id) return { error: 'You’re already at this table.' };
        if (other) return { error: `You’re sitting at the ${TABLES_BY_ID.get(other.id).name}. Leave it first.` };
        const free = s.seats.map((x, i) => (x ? null : i)).filter((i) => i !== null);
        const i = seatIndex === undefined || seatIndex === null || seatIndex === '' ? free[0] : Number(seatIndex);
        if (!free.length) return { error: 'This table is full.' };
        if (!Number.isInteger(i) || i < 0 || i >= SEATS || s.seats[i]) return { error: 'That seat is taken.' };
        const u = stmts.user.get(userId);
        s.seats[i] = { userId, username: u.username, avatarV: u.avatar_v || 0, bet: 0, hands: [], lastSeen: now, skipped: 0 };
        log(s, `${u.username} sits down.`);
        return { seat: i };
      });
    },

    leave({ tableId, userId, now = Date.now() }) {
      return withTable(tableId, now, (s) => {
        const i = seatOf(s, userId);
        if (i < 0) return { error: 'You’re not at this table.' };
        const seat = s.seats[i];
        if (s.phase === 'playing' && seat.hands && seat.hands.length) {
          // Their bet stays in play: unfinished hands stand, and they're paid at the end.
          seat.leaving = true;
          log(s, `${seat.username} is leaving after this hand.`);
          if (s.turn && s.turn.seat === i) next(s, now);
          return { leaving: true };
        }
        if (seat.bet > 0 && (s.phase === 'betting' || s.phase === 'idle')) payCash(userId, seat.bet, s, now); // not dealt yet: refund
        s.seats[i] = null;
        log(s, `${seat.username} left the table.`);
        if (s.phase === 'betting' && !s.seats.some((x) => x && x.bet > 0)) { s.phase = 'idle'; s.deadline = null; }
        return { left: true };
      });
    },

    bet({ tableId, userId, amount, now = Date.now() }) {
      return withTable(tableId, now, (s) => {
        const i = seatOf(s, userId);
        if (i < 0) return { error: 'Take a seat first.' };
        const seat = s.seats[i];
        if (s.phase !== 'idle' && s.phase !== 'betting') return { error: 'Wait for this round to finish.' };
        if (seat.bet > 0) return { error: 'Your bet is already down for this round.' };
        const player = game.applyRegen(players.findById(userId), now);
        const why = blocker(player);
        if (why) return { error: why };
        const { min, max } = limitsOf(TABLES_BY_ID.get(s.id));
        const bet = Number(String(amount ?? '').replace(/[$,\s]/g, ''));
        if (!Number.isInteger(bet) || bet <= 0) return { error: 'Enter a whole-dollar bet.' };
        if (bet < min || bet > max) return { error: `Bets at this table are ${money(min)} to ${money(max)}.` };
        if (bet > player.cash) return { error: `You only have ${money(player.cash)} in cash. Bets come from cash, not the bank.` };
        const limited = casinoPlayer.stakeBlocker(userId, bet, now);
        if (limited) return { error: limited };
        payCash(userId, -bet, s, now);
        seat.bet = bet;
        seat.lastSeen = now;
        seat.leaving = false;
        log(s, `${seat.username} bets ${money(bet)}.`);
        if (s.phase === 'idle') {
          s.phase = 'betting';
          s.deadline = now + BET_MS;
        }
        // Everyone seated has bet: no need to wait.
        if (s.seats.every((x) => !x || x.bet > 0)) deal(s, now);
        return { bet };
      });
    },

    /** hit / stand / double / split for the hand whose turn it is. `round` guards against a stale double-tap. */
    act({ tableId, userId, action, round, now = Date.now() }) {
      return withTable(tableId, now, (s) => {
        const i = seatOf(s, userId);
        if (i < 0) return { error: 'You’re not at this table.' };
        if (s.phase !== 'playing' || !s.turn || s.turn.seat !== i) return { error: 'It isn’t your turn.' };
        if (round !== undefined && Number(round) !== s.round) return { error: 'That round is over.' };
        const seat = s.seats[i];
        const hand = seat.hands[s.turn.hand];
        const player = game.applyRegen(players.findById(userId), now);
        const cash = stakeable(player, now);
        const allowed = bj.actionsFor(hand, { handsInSeat: seat.hands.length, cash });
        if (!allowed.includes(action)) {
          if (action !== 'double' && action !== 'split') return { error: 'You can’t do that now.' };
          const why = player.cash < hand.bet ? ' (not enough cash)' : cash < hand.bet ? ' (it would pass your daily loss limit)' : '';
          return { error: `You can’t ${action} this hand${why}.` };
        }
        seat.lastSeen = now;
        if (action === 'hit') {
          hand.cards.push(draw(s));
          if (bj.handValue(hand.cards).total >= 21) hand.done = true;
        } else if (action === 'stand') {
          hand.done = true;
        } else if (action === 'double') {
          payCash(userId, -hand.bet, s, now);
          hand.bet *= 2;
          hand.doubled = true;
          hand.cards.push(draw(s));
          hand.done = true;
          log(s, `${seat.username} doubles down.`);
        } else if (action === 'split') {
          payCash(userId, -hand.bet, s, now);
          const aces = bj.rankOf(hand.cards[0]) === 'A';
          seat.hands = hand.cards.map((c) => ({ cards: [c, draw(s)], bet: hand.bet, doubled: false, split: true, done: aces }));
          for (const h of seat.hands) if (bj.handValue(h.cards).total === 21) h.done = true;
          log(s, `${seat.username} splits.`);
        }
        const current = seat.hands[s.turn.hand];
        if (current.done) {
          if (action !== 'double' && bj.isBust(current.cards)) log(s, `${seat.username} busts.`);
          next(s, now);
        } else s.deadline = now + TURN_MS;
        return { ok: true };
      });
    },

    /** The table from one player's point of view (no shoe; the hole card hidden until the dealer plays). */
    view(tableId, userId, now = Date.now()) {
      const s = states.get(Number(tableId));
      if (!s) return null;
      const table = TABLES_BY_ID.get(s.id);
      const mine = seatOf(s, userId);
      if (mine >= 0) s.seats[mine].lastSeen = now; // looking at the table keeps your seat (saved with the next change)
      const reveal = s.phase === 'done' || (s.phase === 'playing' && !s.turn);
      const dealerCards = s.dealer.map((c, i) => (i === 1 && !reveal ? null : bj.show(c)));
      const player = mine >= 0 ? game.applyRegen(players.findById(userId), now) : null;
      return {
        table: { ...table, ...limitsOf(table) },
        version: s.version,
        phase: s.phase,
        round: s.round,
        deadlineIn: s.deadline ? Math.max(0, s.deadline - now) : null,
        dealer: { cards: dealerCards, total: reveal && s.dealer.length ? bj.handValue(s.dealer).total : s.dealer.length ? bj.cardValue(s.dealer[0]) : null },
        seats: s.seats.map((seat, i) => (seat ? {
          index: i,
          userId: seat.userId,
          username: seat.username,
          avatarV: seat.avatarV,
          you: i === mine,
          bet: seat.bet,
          leaving: Boolean(seat.leaving),
          turn: Boolean(s.turn && s.turn.seat === i),
          hands: (seat.hands || []).map((h, hi) => ({
            cards: h.cards.map(bj.show),
            ...bj.handValue(h.cards),
            bet: h.bet,
            doubled: h.doubled,
            blackjack: bj.isBlackjack(h.cards) && !h.split,
            result: h.result || null,
            resultLabel: h.result ? bj.RESULT_LABEL[h.result] : null,
            payout: h.payout || 0,
            active: Boolean(s.turn && s.turn.seat === i && s.turn.hand === hi),
          })),
        } : { index: i, empty: true })),
        you: mine >= 0 ? {
          seat: mine,
          cash: player.cash,
          canBet: (s.phase === 'idle' || s.phase === 'betting') && !s.seats[mine].bet,
          actions: s.turn && s.turn.seat === mine ? bj.actionsFor(s.seats[mine].hands[s.turn.hand], { handsInSeat: s.seats[mine].hands.length, cash: stakeable(player, now) }) : [],
        } : null,
        atOtherTable: mine < 0 && tableOf(userId) ? TABLES_BY_ID.get(tableOf(userId).id).name : null,
        log: [...s.log].reverse(),
      };
    },

    /** Moves every table past its deadlines (betting closes, turns time out, rounds end). */
    tick(now = Date.now()) {
      for (const s of states.values()) {
        if (!s.deadline && !(s.phase === 'idle' && s.seats.some(Boolean))) continue;
        players.transaction(() => guarded(s, () => { if (advance(s, now)) save(s, now); }));
      }
    },

    schedule() {
      const timer = setInterval(() => { try { this.tick(); } catch (err) { console.error('[blackjack] tick failed', err); } }, 1000);
      timer.unref();
    },

    /** Tests: the raw state of a table. */
    _state: (tableId) => states.get(Number(tableId)),
  };
}

module.exports = { BET_MS, DONE_MS, IDLE_MS, SEATS, TABLES, TURN_MS, createBlackjackService };
