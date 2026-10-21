'use strict';

const contracts = require('./contracts');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * Contracts backed by the database (rules in src/contracts.js). post(),
 * accept(), decline(), cancel() and abandon() open their own transactions;
 * afterFight() runs inside the PvP attack's. Escrow moves through the ledger:
 * `contract-posted` (pay plus fee out), `contract-pay` (to the mercenary),
 * `contract-refund` (what wasn't earned, back to the client).
 * `isLinked(a, b, now)` comes from anti-cheat (shared device or network).
 */
function createContractService(db, players, isLinked) {
  const stmts = {
    insert: db.prepare(`INSERT INTO contracts (kind, client_id, target_id, offered_to, jobs, knockout, amount, fee, hours, created_at)
                        VALUES (@kind, @client, @target, @offered, @jobs, @knockout, @amount, @fee, @hours, @now)`),
    byId: db.prepare('SELECT * FROM contracts WHERE id = ?'),
    posted: db.prepare("SELECT COUNT(*) AS n FROM contracts WHERE client_id = ? AND status IN ('open', 'active')"),
    jobs: db.prepare("SELECT COUNT(*) AS n FROM contracts WHERE merc_id = ? AND status = 'active'"),
    accept: db.prepare("UPDATE contracts SET status = 'active', merc_id = ?, accepted_at = ?, deadline = ? WHERE id = ? AND status = 'open'"),
    settle: db.prepare("UPDATE contracts SET status = ?, settled_at = ? WHERE id = ? AND status IN ('open', 'active')"),
    progress: db.prepare('UPDATE contracts SET progress = progress + 1, paid = paid + ? WHERE id = ?'),
    hit: db.prepare('INSERT OR IGNORE INTO contract_hits (contract_id, battle_id, foe_id, cash, created_at) VALUES (?, ?, ?, ?, ?)'),
    foeDone: db.prepare('SELECT 1 FROM contract_hits WHERE contract_id = ? AND foe_id = ?'),
    aggressor: db.prepare('SELECT 1 FROM battles WHERE defender_id = ? AND attacker_id = ? AND created_at >= ? AND reversed_at IS NULL LIMIT 1'),
    activeFor: db.prepare("SELECT * FROM contracts WHERE merc_id = ? AND status = 'active'"),
    done: db.prepare('UPDATE users SET contracts_done = contracts_done + 1 WHERE id = ?'),
    failed: db.prepare('UPDATE users SET contracts_failed = contracts_failed + 1 WHERE id = ?'),
    dueActive: db.prepare("SELECT id FROM contracts WHERE status = 'active' AND deadline <= ?"),
    dueOpen: db.prepare("SELECT id FROM contracts WHERE status = 'open' AND created_at <= ?"),
    board: db.prepare(`SELECT c.*, cl.username AS client, cl.level AS client_level, t.username AS target, t.level AS target_level, o.username AS offered
                       FROM contracts c JOIN users cl ON cl.id = c.client_id LEFT JOIN users t ON t.id = c.target_id LEFT JOIN users o ON o.id = c.offered_to
                       WHERE c.status = 'open' AND (c.offered_to IS NULL OR c.offered_to = ?1) AND c.client_id != ?1 AND (c.target_id IS NULL OR c.target_id != ?1) AND cl.banned_at IS NULL
                       ORDER BY c.offered_to IS NULL, c.amount DESC LIMIT 50`),
    mine: db.prepare(`SELECT c.*, m.username AS merc, t.username AS target, o.username AS offered FROM contracts c
                      LEFT JOIN users m ON m.id = c.merc_id LEFT JOIN users t ON t.id = c.target_id LEFT JOIN users o ON o.id = c.offered_to
                      WHERE c.client_id = ? ORDER BY c.status IN ('open', 'active') DESC, c.id DESC LIMIT 20`),
    working: db.prepare(`SELECT c.*, cl.username AS client, t.username AS target FROM contracts c
                         JOIN users cl ON cl.id = c.client_id LEFT JOIN users t ON t.id = c.target_id
                         WHERE c.merc_id = ? ORDER BY c.status = 'active' DESC, c.id DESC LIMIT 20`),
    recent: db.prepare(`SELECT c.kind, c.amount, c.jobs, c.knockout, c.settled_at, m.username AS merc, t.username AS target, cl.username AS client
                        FROM contracts c JOIN users m ON m.id = c.merc_id JOIN users cl ON cl.id = c.client_id LEFT JOIN users t ON t.id = c.target_id
                        WHERE c.status = 'completed' ORDER BY c.settled_at DESC LIMIT ?`),
    rep: db.prepare('SELECT contracts_done AS done, contracts_failed AS failed FROM users WHERE id = ?'),
  };

  const linked = (now) => (a, b) => Boolean(isLinked(a, b, now));
  const user = (id) => (id ? players.findById(id) : null);
  const textOf = (c) => contracts.describe(c, { target: user(c.target_id), client: user(c.client_id) });

  /** Moves cash in or out of a player through the ledger. */
  function pay(userId, cash, reason, ref) {
    if (!cash) return;
    const p = players.findById(userId);
    p.cash += cash;
    players.save(p, { reason, ref });
  }

  /** Closes a contract with `status`, refunding what wasn't earned to the client. Returns the refund. */
  function close(c, status, now) {
    if (!stmts.settle.run(status, now, c.id).changes) return null;
    const fresh = stmts.byId.get(c.id);
    const refund = fresh.amount - fresh.paid;
    pay(fresh.client_id, refund, 'contract-refund', `contract:${c.id}`);
    return refund;
  }

  return {
    reputation: (userId) => stmts.rep.get(userId) || { done: 0, failed: 0 },
    describe: textOf,

    /** Posts a contract. Returns { error } or { contract, terms }. */
    post(clientId, input, { targetName = '', offerName = '' } = {}, now = Date.now()) {
      const terms = contracts.parseTerms(input);
      if (terms.error) return terms;
      return players.transaction(() => {
        const client = players.findById(clientId);
        const target = terms.kind === 'hit' && targetName ? players.findByUsername(String(targetName)) : null;
        if (terms.kind === 'hit' && targetName && !target) return { error: `No soldier called ${targetName}.` };
        const offeredTo = offerName ? players.findByUsername(String(offerName)) : null;
        if (offerName && !offeredTo) return { error: `No soldier called ${offerName}.` };
        const why = contracts.postBlocker(client, terms, { target, offeredTo, posted: stmts.posted.get(clientId).n, linked: linked(now) });
        if (why) return { error: why };
        const id = Number(stmts.insert.run({ kind: terms.kind, client: clientId, target: target ? target.id : null, offered: offeredTo ? offeredTo.id : null, jobs: terms.jobs, knockout: terms.knockout ? 1 : 0, amount: terms.amount, fee: terms.fee, hours: terms.hours, now }).lastInsertRowid);
        pay(clientId, -(terms.amount + terms.fee), 'contract-posted', `contract:${id}`);
        const c = stmts.byId.get(id);
        if (offeredTo) players.notify(offeredTo.id, 'contract', `${client.username} offers you a contract: ${textOf(c)} within ${terms.hours} hours, for ${money(terms.amount)}.`, `/contracts#c-${id}`);
        return { contract: c, terms, text: textOf(c) };
      });
    },

    /** A mercenary takes a contract (it's theirs alone from now). */
    accept(mercId, id, now = Date.now()) {
      return players.transaction(() => {
        const c = stmts.byId.get(id);
        if (!c || c.status !== 'open') return { error: 'That contract isn’t open any more.' };
        if (c.offered_to && c.offered_to !== mercId) return { error: 'That contract was offered to someone else.' };
        const merc = players.findById(mercId);
        const client = user(c.client_id);
        const target = user(c.target_id);
        if (c.kind === 'hit' && (!target || target.banned_at)) return { error: 'The target is no longer available.' };
        const why = contracts.mercBlocker(merc, c, { jobs: stmts.jobs.get(mercId).n, linked: linked(now), client, target });
        if (why) return { error: why };
        const deadline = now + c.hours * HOUR;
        if (!stmts.accept.run(mercId, now, deadline, id).changes) return { error: 'That contract isn’t open any more.' };
        const text = textOf(c);
        players.notify(c.client_id, 'contract', `${merc.username} took your contract: ${text}. They have ${c.hours} hours.`, `/contracts#c-${id}`);
        if (c.kind === 'hit') players.notify(c.target_id, 'contract', 'Someone has hired a mercenary to take you down. Watch your back.', null);
        return { contract: stmts.byId.get(id), text, deadline };
      });
    },

    /** The mercenary a contract was offered to turns it down; the client gets the pay back (not the fee). */
    decline(mercId, id, now = Date.now()) {
      return players.transaction(() => {
        const c = stmts.byId.get(id);
        if (!c || c.status !== 'open' || c.offered_to !== mercId) return { error: 'There’s no offer like that waiting for you.' };
        const refund = close(c, 'declined', now);
        players.notify(c.client_id, 'contract', `${players.findById(mercId).username} turned down your contract. ${money(refund)} is back in your cash.`, '/contracts');
        return { refund };
      });
    },

    /** The client withdraws a contract nobody has taken yet (the fee isn't refunded). */
    cancel(clientId, id, now = Date.now()) {
      return players.transaction(() => {
        const c = stmts.byId.get(id);
        if (!c || c.client_id !== clientId) return { error: 'That isn’t your contract.' };
        if (c.status !== 'open') return { error: 'Only contracts nobody has taken yet can be withdrawn.' };
        return { refund: close(c, 'cancelled', now) };
      });
    },

    /** The mercenary walks away from a job: what's left goes back to the client, and it counts as failed. */
    abandon(mercId, id, now = Date.now()) {
      return players.transaction(() => {
        const c = stmts.byId.get(id);
        if (!c || c.merc_id !== mercId || c.status !== 'active') return { error: 'That isn’t one of your jobs.' };
        const refund = close(c, 'failed', now);
        stmts.failed.run(mercId);
        players.notify(c.client_id, 'contract', `${players.findById(mercId).username} abandoned your contract. ${money(refund)} is back in your cash.`, '/contracts');
        return { refund };
      });
    },

    /**
     * Counts a PvP fight towards the attacker's contracts (inside the attack's
     * transaction). Only full-reward wins count. Returns [{ id, cash, completed }].
     */
    afterFight({ battleId, attackerId, defenderId, attackerWon, fullReward, knockout, now = Date.now() }) {
      if (!attackerWon || !fullReward) return [];
      const out = [];
      for (const c of stmts.activeFor.all(attackerId)) {
        if (c.deadline <= now) continue; // expireDue settles it
        let counts = false;
        if (c.kind === 'hit') counts = defenderId === c.target_id && (!c.knockout || knockout);
        else counts = defenderId !== c.client_id && !stmts.foeDone.get(c.id, defenderId) && Boolean(stmts.aggressor.get(c.client_id, defenderId, c.accepted_at));
        if (!counts) continue;
        const n = c.progress + 1;
        // A hit pays on the last win; bodyguard duty pays a share for each soldier beaten.
        const cash = c.kind === 'hit' ? (n >= c.jobs ? c.amount : 0) : contracts.shareOf(c, n);
        stmts.hit.run(c.id, battleId, defenderId, cash, now);
        stmts.progress.run(cash, c.id);
        pay(attackerId, cash, 'contract-pay', `contract:${c.id}`);
        const text = textOf(c);
        const completed = n >= c.jobs;
        if (completed) {
          close(c, 'completed', now);
          stmts.done.run(attackerId);
          players.notify(c.client_id, 'contract', `Contract complete: ${players.findById(attackerId).username} finished the job (${text}).`, `/battles/${battleId}`);
          players.notify(attackerId, 'contract', `Contract complete: ${text}. +${money(cash)}.`, `/battles/${battleId}`);
        } else {
          players.notify(c.client_id, 'contract', `Progress on your contract: ${n} of ${c.jobs} (${text}).`, `/battles/${battleId}`);
        }
        out.push({ id: c.id, cash, completed, n, jobs: c.jobs, text });
      }
      return out;
    },

    /** Settles contracts past their deadline, and refunds ones nobody took within a week. */
    expireDue(now = Date.now()) {
      let n = 0;
      for (const { id } of stmts.dueActive.all(now)) {
        players.transaction(() => {
          const c = stmts.byId.get(id);
          if (!c || c.status !== 'active') return;
          // Bodyguard duty that earned something counts as done; nobody may have attacked the client at all.
          const status = c.progress > 0 && c.kind === 'guard' ? 'completed' : 'failed';
          const refund = close(c, status, now);
          if (c.kind === 'hit') stmts.failed.run(c.merc_id);
          else if (c.progress > 0) stmts.done.run(c.merc_id);
          const text = textOf(c);
          players.notify(c.client_id, 'contract', `Your contract ran out of time (${text}): ${c.progress} of ${c.jobs} done.${refund ? ` ${money(refund)} is back in your cash.` : ''}`, '/contracts');
          if (c.merc_id) players.notify(c.merc_id, 'contract', `Time’s up on your contract (${text}): ${c.progress} of ${c.jobs} done.`, '/contracts');
          n += 1;
        });
      }
      for (const { id } of stmts.dueOpen.all(now - contracts.OPEN_DAYS * DAY)) {
        players.transaction(() => {
          const c = stmts.byId.get(id);
          if (!c || c.status !== 'open') return;
          const refund = close(c, 'expired', now);
          players.notify(c.client_id, 'contract', `Nobody took your contract in ${contracts.OPEN_DAYS} days. ${money(refund)} is back in your cash.`, '/contracts');
          n += 1;
        });
      }
      return n;
    },
    schedule() {
      setInterval(() => { try { this.expireDue(); } catch (err) { console.error('[contracts] expiry failed', err); } }, 60 * 1000).unref();
    },

    /** Everything the contracts page shows for `viewer`. */
    view(viewer, now = Date.now()) {
      const jobs = stmts.jobs.get(viewer.id).n;
      const shape = (c) => ({ ...c, text: textOf(c), kindName: contracts.KINDS[c.kind].name, left: c.deadline ? Math.max(0, c.deadline - now) : null });
      return {
        board: stmts.board.all(viewer.id).map((c) => ({ // never shows a target the hit on them
          ...shape(c),
          blocker: contracts.mercBlocker(viewer, c, { jobs, linked: linked(now), client: user(c.client_id), target: user(c.target_id) }),
        })),
        mine: stmts.mine.all(viewer.id).map(shape),
        working: stmts.working.all(viewer.id).map(shape),
        recent: stmts.recent.all(6),
        reputation: stmts.rep.get(viewer.id),
        posted: stmts.posted.get(viewer.id).n,
        jobs,
      };
    },
  };
}

module.exports = { createContractService };
