'use strict';

/**
 * Blackjack (pure): cards, hand values, the shoe, the dealer and settling.
 * House rules: six decks, dealer stands on all 17s, blackjack pays 3 to 2,
 * double on any first two cards, split once (no re-splits; split aces get one
 * card each and a two-card 21 after a split counts as 21, not blackjack).
 * The dealer checks for blackjack under an ace or ten before anyone acts.
 */

const crypto = require('node:crypto');

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];
const DECKS = 6;
const RESHUFFLE_AT = 0.25; // a new shoe when a quarter of it is left
const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };

const rankOf = (card) => card.slice(0, -1);
const suitOf = (card) => card.slice(-1);
const cardValue = (card) => {
  const r = rankOf(card);
  if (r === 'A') return 11;
  if (r === 'J' || r === 'Q' || r === 'K') return 10;
  return Number(r);
};

/** A hand's best total, and whether an ace is still counting as 11 (soft). */
function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardValue(c);
    if (rankOf(c) === 'A') aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;
const isBust = (cards) => handValue(cards).total > 21;

/** A freshly shuffled shoe (Fisher–Yates with a cryptographic RNG). */
function newShoe(randomInt = crypto.randomInt, decks = DECKS) {
  const shoe = [];
  for (let d = 0; d < decks; d += 1) for (const s of SUITS) for (const r of RANKS) shoe.push(r + s);
  for (let i = shoe.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}
const needsShuffle = (shoe, decks = DECKS) => shoe.length < decks * 52 * RESHUFFLE_AT;

/** The dealer draws to 17 (standing on soft 17). Mutates and returns `cards`. */
function dealerPlay(cards, draw) {
  while (handValue(cards).total < 17) cards.push(draw());
  return cards;
}

/** Whether the dealer peeks for blackjack with this upcard. */
const dealerPeeks = (upcard) => cardValue(upcard) >= 10;

/** What a player may do with a hand right now. */
function actionsFor(hand, { handsInSeat, cash }) {
  if (hand.done) return [];
  const two = hand.cards.length === 2;
  const actions = ['hit', 'stand'];
  if (two && cash >= hand.bet) actions.push('double');
  if (two && handsInSeat === 1 && rankOf(hand.cards[0]) === rankOf(hand.cards[1]) && cash >= hand.bet) actions.push('split');
  return actions;
}

/**
 * Settles one player hand against the dealer. Returns { result, payout }:
 * the payout includes the stake back (0 for a loss).
 */
function settleHand(hand, dealerCards) {
  const player = handValue(hand.cards).total;
  const dealer = handValue(dealerCards).total;
  const playerBj = isBlackjack(hand.cards) && !hand.split;
  const dealerBj = isBlackjack(dealerCards);
  if (player > 21) return { result: 'bust', payout: 0 };
  if (playerBj && dealerBj) return { result: 'push', payout: hand.bet };
  if (playerBj) return { result: 'blackjack', payout: hand.bet + Math.floor((hand.bet * 3) / 2) };
  if (dealerBj) return { result: 'lose', payout: 0 };
  if (dealer > 21 || player > dealer) return { result: 'win', payout: hand.bet * 2 };
  if (player === dealer) return { result: 'push', payout: hand.bet };
  return { result: 'lose', payout: 0 };
}

const RESULT_LABEL = { blackjack: 'Blackjack!', win: 'Win', push: 'Push', lose: 'Lose', bust: 'Bust' };

/** A card for display: { rank, suit, red, label }. */
function show(card) {
  const suit = suitOf(card);
  return { rank: rankOf(card), suit: SUIT_SYMBOL[suit], red: suit === 'H' || suit === 'D', label: `${rankOf(card)}${SUIT_SYMBOL[suit]}` };
}

module.exports = { DECKS, RESULT_LABEL, actionsFor, cardValue, dealerPeeks, dealerPlay, handValue, isBlackjack, isBust, needsShuffle, newShoe, rankOf, settleHand, show };
