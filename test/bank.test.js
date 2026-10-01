'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bank = require('../src/bank');

const p = (cash, bank_balance = 0) => ({ cash, bank_balance });

test('parseAmount accepts plain numbers, commas, $ and "all"', () => {
  assert.equal(bank.parseAmount('1500', 0), 1500);
  assert.equal(bank.parseAmount(' $1,500 ', 0), 1500);
  assert.equal(bank.parseAmount('ALL', 900), 900);
  for (const bad of ['', '0', '-5', '1.5', 'abc', '1e6', null, undefined]) assert.equal(bank.parseAmount(bad, 100), null, String(bad));
  assert.equal(bank.parseAmount('all', 0), null);
});

test('deposits charge 2% (min $1) and never create money', () => {
  const out = bank.deposit(p(1000, 50), '1000');
  assert.equal(out.fee, 20);
  assert.equal(out.credited, 980);
  assert.equal(out.player.cash, 0);
  assert.equal(out.player.bank_balance, 1030);
  assert.equal(bank.depositFee(10), 1);
  assert.equal(bank.depositFee(151), 4); // rounds up
  assert.match(bank.deposit(p(1), '1').error, /more than the \$1 fee/);
  assert.match(bank.deposit(p(100), '101').error, /only have \$100/);
  assert.match(bank.deposit(p(100), 'abc').error, /Enter an amount/);
});

test('withdrawals are free and limited to the balance', () => {
  const out = bank.withdraw(p(10, 500), 'all');
  assert.equal(out.player.cash, 510);
  assert.equal(out.player.bank_balance, 0);
  assert.match(bank.withdraw(p(0, 50), '51').error, /balance is \$50/);
});
