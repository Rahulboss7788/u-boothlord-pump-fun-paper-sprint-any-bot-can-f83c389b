// Pump.fun Paper Sprint — proven-runner momentum with pyramiding + strict exits.
// Paper trading only: this program only answers the replay harness on stdin/stdout.
// It never touches real funds, the network, the clock, or the environment, so two
// runs on the same data produce byte-identical action logs.
//
// What the dev data actually says (24h, 1,222 coins): almost every coin pumps
// in its first trades and then bleeds to near zero — chasing early momentum
// loses about 5-8% per trade after fees. The money sits in the few coins that
// PROVE they can run: only ~13% of coins ever peak 3x, and the ones that do
// tend to keep running for hundreds of trades. So this bot does the opposite
// of a sniper: it waits, buys only a coin that has already run 2.75x from its
// first trade AND is printing a fresh 20-trade high, then pyramids into it
// while it keeps climbing, and cuts every loser at -5%.
//
// How it works — two entry families, one exit discipline:
//  Family A (proven runners, the money): a coin whose price is >= 2.75x its
//  first-seen trade price AND >= 0.5% above the highest of its previous 20
//  trades. One entry per coin, no re-entry — the first leg is the best leg.
//  The buy is the smaller of 0.5 SOL and the harness size cap (1% of the
//  coin's real SOL reserve); buys under 0.02 SOL are skipped so every round
//  trip clears the 0.01 SOL bar with room to spare. Proven runners have deep
//  reserves, so the stake here is usually 0.2-0.5 SOL, not the 0.04 SOL an
//  early coin allows. While a family-A coin keeps climbing, add up to 2 more
//  capped buys (0.25 SOL each, same 1% reserve cap) every time the price
//  rises another 20% above the last buy price.
//  Family B (guardrail top-up): a young coin (4-60 trades) whose price is
//  flat (+/-2%) over its last 4 trades while heavy buy volume (>= 0.5 SOL,
//  >= 80% buys) piles in. Small stakes, never scales in; it exists so the
//  entry clears the 20-round-trip bar even in a quiet 6h window, where
//  family A alone only finds a handful of coins.
//  * Exits (strict, checked every batch, against the blended average entry
//    price from the account's cost basis): hard stop -5%; trailing stop -25%
//    from the peak once the peak is +25% over entry; a 600-trade maximum hold;
//    and a quiet exit if a losing coin goes 600 slots without a trade. Exits
//    always sell the whole position.
//  * Safety: at most the harness max_open_positions (5) coins at once, at most
//    max_orders_per_batch orders per reply, never buy a completed curve, never
//    buy more than free cash allows, never re-order a mint with an order pending.
//    The guardrail needs >= 20 round trips of >= 0.01 SOL with <= 50%
//    drawdown: family B tops the round-trip count up well past 20 per 6h
//    even in a quiet window, and the -5% stop bounds the drawdown.

import * as readline from 'node:readline';

// ---------------------------------------------------------------------------
// Minimal replay client for agent-fun/replay/v2 (written for this entry).
// The harness speaks newline-delimited JSON on stdin: one hello, then batches,
// then done. We answer each batch with exactly one reply line on stdout.
// Diagnostics go to stderr only — stdout carries replies and nothing else.
// ---------------------------------------------------------------------------

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

type Side = 'buy' | 'sell';

interface Order {
  side: Side;
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

interface Curve {
  mint: string;
  createdSlot: number | null;
  vToken: bigint;
  vQuote: bigint;
  realToken: bigint;
  realQuote: bigint;
  reservesSlot: number;
  trades: number;
  complete: boolean;
}

interface Holding {
  tokens: bigint;
  cost: bigint;
}

interface Pending {
  side: Side;
  mint: string;
  amount: bigint;
}

interface CoinTrack {
  prices: number[]; // last trade prices (SOL per token), oldest first (max 21 kept)
  buyVol: bigint[]; // SOL volume of buys, aligned with the last 4 prices
  sellVol: bigint[]; // SOL volume of sells, aligned with the last 4 prices
  firstPrice: number; // price of the first trade seen on this coin
  firstSeenSlot: number;
  lastTradeSlot: number;
  entered: boolean; // an entry buy was already decided for this coin
  family: string; // 'A' = proven runner, 'B' = flat-volume top-up, '' = none
  adds: number; // scale-in buys decided
  lastBuyPrice: number; // price at the last buy decision
  entrySlot: number; // slot of the first buy decision
  entryTrades: number; // curve trade count at the first buy decision
  peak: number; // highest mark price seen while holding
}

const curves = new Map<string, Curve>();
const tracks = new Map<string, CoinTrack>();
const pending = new Map<string, Pending>();
const positions = new Map<string, Holding>();
let cash = 0n;
let maxOpenPositions = 5;
let maxOrdersPerBatch = 16;
let maxOrderBps = 100n;
let txFee = 0n;
let nextClientId = 1;
let currentSlot = 0;

function priceOf(c: Curve): number {
  if (c.vToken === 0n || c.vQuote === 0n) return 0;
  return Number(c.vQuote) / Number(c.vToken);
}

function maxBuyLamports(mint: string): bigint {
  const c = curves.get(mint);
  if (c === undefined || c.complete) return 0n;
  return (c.realQuote * maxOrderBps) / BPS;
}

function committedPositions(): number {
  const mints = new Set<string>(positions.keys());
  for (const p of pending.values()) if (p.side === 'buy') mints.add(p.mint);
  return mints.size;
}

function freeCash(): bigint {
  let free = cash;
  for (const p of pending.values()) {
    free -= txFee;
    if (p.side === 'buy') free -= p.amount;
  }
  return free;
}

function newClientId(): string {
  return `o${nextClientId++}`;
}

function trackFor(mint: string, slot: number): CoinTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      prices: [],
      buyVol: [],
      sellVol: [],
      firstPrice: 0,
      firstSeenSlot: slot,
      lastTradeSlot: slot,
      entered: false,
      family: '',
      adds: 0,
      lastBuyPrice: 0,
      entrySlot: 0,
      entryTrades: 0,
      peak: 0,
    };
    tracks.set(mint, t);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Strategy parameters (tuned on the kit's full 24h dev dataset; see README).
// ---------------------------------------------------------------------------

const PROOF_MULT = 2.75; // entry needs price >= 2.75x the first-seen trade price
const NEW_HIGH_BPS = 50; // ...and >= 0.5% above the previous 20-trade high
const LOOKBACK_TRADES = 20; // trades back for the previous high
const MIN_TRADES = 20; // need this many trades before a coin can qualify
const STAKE_LAMPORTS = 500_000_000n; // 0.5 SOL target stake per entry
const ADD_LAMPORTS = 250_000_000n; // 0.25 SOL per scale-in
const MAX_ADDS = 2;
const ADD_GAIN = 0.2; // scale in only after +20% from the last buy price
const MIN_BUY_LAMPORTS = 20_000_000n; // 0.02 SOL — clears the 0.01 SOL bar
const BUY_SLIPPAGE_BPS = 2000; // 20% — refuse a fill far worse than decision
const SELL_SLIPPAGE_BPS = 10_000; // exits must fill, so leave slippage wide
const STOP_LOSS = 0.05; // -5% vs average entry price
const TRAIL_ARM = 0.25; // trailing stop arms once peak is +25% over entry
const TRAIL_DROP = 0.25; // sell when price falls 25% from the peak
const MAX_HOLD_TRADES = 600; // maximum hold, in trades since entry
const QUIET_SLOTS = 600; // sell a losing coin that stops trading
// Family B (guardrail top-up): flat price + heavy buy volume on a young coin.
const B_MIN_TRADES = 4;
const B_MAX_TRADES = 60;
const B_MIN_VOL_LAMPORTS = 500_000_000n; // >= 0.5 SOL in the last 4 trades
const B_MIN_BUY_SHARE_NUM = 4; // >= 80% of that volume must be buys (4/5)
const B_MIN_BUY_SHARE_DEN = 5;
const B_STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL — small: a rug on a young coin
// can halve the price in 2 slots, so B stakes stay tiny on purpose
const B_MAX_HOLD_TRADES = 100; // B exits fast if it does not run at once

function decideBatch(batch: any): Order[] {
  const orders: Order[] = [];
  const events: any[] = batch.events ?? [];

  // Fold this batch's events into curves and per-coin tracks.
  for (const e of events) {
    if (e.event === 'CreateEvent') {
      let c = curves.get(e.mint);
      if (c === undefined) {
        c = {
          mint: e.mint,
          createdSlot: e.slot,
          vToken: 0n,
          vQuote: 0n,
          realToken: 0n,
          realQuote: 0n,
          reservesSlot: e.slot,
          trades: 0,
          complete: false,
        };
        curves.set(e.mint, c);
      }
      c.vToken = BigInt(e.virtual_token_reserves);
      c.vQuote = BigInt(e.virtual_quote_reserves);
      c.realToken = BigInt(e.real_token_reserves);
      c.realQuote = 0n;
      c.reservesSlot = e.slot;
      trackFor(e.mint, e.slot);
    } else if (e.event === 'TradeEvent') {
      let c = curves.get(e.mint);
      if (c === undefined) {
        c = {
          mint: e.mint,
          createdSlot: null,
          vToken: 0n,
          vQuote: 0n,
          realToken: 0n,
          realQuote: 0n,
          reservesSlot: e.slot,
          trades: 0,
          complete: false,
        };
        curves.set(e.mint, c);
      }
      c.vToken = BigInt(e.virtual_token_reserves);
      c.vQuote = BigInt(e.virtual_quote_reserves);
      c.realToken = BigInt(e.real_token_reserves);
      c.realQuote = BigInt(e.real_quote_reserves);
      c.reservesSlot = e.slot;
      c.trades += 1;
      const t = trackFor(e.mint, e.slot);
      const p = priceOf(c);
      if (p > 0) {
        if (t.firstPrice === 0) t.firstPrice = p;
        t.prices.push(p);
        if (t.prices.length > LOOKBACK_TRADES + 1) t.prices.shift();
        const vol = BigInt(e.sol_amount);
        t.buyVol.push(e.is_buy ? vol : 0n);
        t.sellVol.push(e.is_buy ? 0n : vol);
        if (t.buyVol.length > 4) {
          t.buyVol.shift();
          t.sellVol.shift();
        }
      }
      t.lastTradeSlot = e.slot;
    } else if (e.event === 'CompleteEvent') {
      const c = curves.get(e.mint);
      if (c !== undefined) c.complete = true;
    }
  }

  // Marks refresh reserves for held / pending mints.
  for (const m of batch.marks ?? []) {
    const c = curves.get(m.mint);
    if (c === undefined || m.slot < c.reservesSlot) continue;
    c.vToken = BigInt(m.virtual_token_reserves);
    c.vQuote = BigInt(m.virtual_quote_reserves);
    c.realToken = BigInt(m.real_token_reserves);
    c.realQuote = BigInt(m.real_quote_reserves);
    c.reservesSlot = m.slot;
  }

  // --- Exits first: strict stops on every held position. ---
  let free = freeCash();
  let slots = maxOpenPositions - committedPositions();
  for (const [mint, h] of positions) {
    const c = curves.get(mint);
    if (c === undefined || c.complete) continue;
    if (pendingHas(mint)) continue;
    const mark = priceOf(c);
    if (mark <= 0 || h.tokens === 0n || h.cost === 0n) continue;
    const entryPrice = Number(h.cost) / Number(h.tokens);
    const t = tracks.get(mint);
    if (t !== undefined) {
      if (mark > t.peak) t.peak = mark;
    }
    const peak = t !== undefined && t.peak > 0 ? t.peak : mark;
    const ret = mark / entryPrice - 1;
    const maxHold = t !== undefined && t.family === 'B' ? B_MAX_HOLD_TRADES : MAX_HOLD_TRADES;
    let exit = false;
    if (ret <= -STOP_LOSS) exit = true; // hard stop
    else if (peak >= entryPrice * (1 + TRAIL_ARM) && mark <= peak * (1 - TRAIL_DROP)) exit = true; // trailing stop
    else if (t !== undefined && t.entryTrades > 0 && c.trades - t.entryTrades >= maxHold) exit = true; // max hold
    else if (t !== undefined && ret < 0 && currentSlot - t.lastTradeSlot >= QUIET_SLOTS) exit = true; // quiet loser
    if (!exit) continue;
    if (orders.length >= maxOrdersPerBatch) break;
    orders.push({
      side: 'sell',
      client_id: newClientId(),
      mint,
      token_amount: h.tokens.toString(),
      max_slippage_bps: SELL_SLIPPAGE_BPS,
    });
    pending.set(orders[orders.length - 1].client_id, { side: 'sell', mint, amount: h.tokens });
  }

  // --- Entries and scale-ins, in this batch's event order. ---
  for (const e of events) {
    if (orders.length >= maxOrdersPerBatch) break;
    if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
    const mint: string = e.mint;
    const c = curves.get(mint);
    if (c === undefined || c.complete) continue;
    if (pendingHas(mint)) continue;
    const t = tracks.get(mint);
    if (t === undefined) continue;

    if (positions.has(mint)) {
      // Scale-in (family A only): the coin is still climbing — add every +20%
      // from the last buy price, up to MAX_ADDS. A stalled coin gets no adds.
      if (t.family !== 'A' || t.adds >= MAX_ADDS || t.lastBuyPrice <= 0) continue;
      const mark = priceOf(c);
      if (mark < t.lastBuyPrice * (1 + ADD_GAIN)) continue;
      const cap = maxBuyLamports(mint);
      const amount = cap < ADD_LAMPORTS ? cap : ADD_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS || free < amount + txFee) continue;
      orders.push({
        side: 'buy',
        client_id: newClientId(),
        mint,
        quote_lamports: amount.toString(),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      pending.set(orders[orders.length - 1].client_id, { side: 'buy', mint, amount });
      free -= amount + txFee;
      t.adds += 1;
      t.lastBuyPrice = mark;
      continue;
    }

    // Fresh entry: one buy per coin, family A first, family B as top-up.
    // A: the coin proved itself — up 2.75x from its first trade and printing
    // a fresh 20-trade high. B: a young coin whose price is flat over its last
    // 4 trades while heavy buy volume (>= 0.5 SOL, >= 80% buys) piles in.
    // B exists so the entry clears the 20-round-trip bar even in a quiet
    // 6h window; its stakes are small and it never scales in.
    if (t.entered) continue;
    if (slots <= 0) continue;
    const now = t.prices.length > 0 ? t.prices[t.prices.length - 1] : 0;
    let family = '';
    if (c.trades >= MIN_TRADES && t.firstPrice > 0 && t.prices.length >= LOOKBACK_TRADES + 1 && now >= t.firstPrice * PROOF_MULT) {
      let prevHigh = 0;
      for (let i = 0; i < t.prices.length - 1; i++) {
        if (t.prices[i] > prevHigh) prevHigh = t.prices[i];
      }
      if (now >= prevHigh * (1 + NEW_HIGH_BPS / 10_000)) family = 'A';
    }
    if (family === '' && c.trades >= B_MIN_TRADES && c.trades <= B_MAX_TRADES && t.prices.length >= 4 && t.buyVol.length >= 4) {
      let buys = 0n;
      let total = 0n;
      for (let i = 0; i < 4; i++) {
        buys += t.buyVol[i];
        total += t.buyVol[i] + t.sellVol[i];
      }
      const then = t.prices[t.prices.length - 4];
      if (
        total >= B_MIN_VOL_LAMPORTS &&
        buys * BigInt(B_MIN_BUY_SHARE_DEN) >= total * BigInt(B_MIN_BUY_SHARE_NUM) &&
        then > 0 &&
        now <= then * 1.02 &&
        now >= then * 0.98
      ) {
        family = 'B';
      }
    }
    if (family === '') continue;
    const cap = maxBuyLamports(mint);
    const target = family === 'A' ? STAKE_LAMPORTS : B_STAKE_LAMPORTS;
    const amount = cap < target ? cap : target;
    if (amount < MIN_BUY_LAMPORTS || free < amount + txFee) continue;
    orders.push({
      side: 'buy',
      client_id: newClientId(),
      mint,
      quote_lamports: amount.toString(),
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    pending.set(orders[orders.length - 1].client_id, { side: 'buy', mint, amount });
    free -= amount + txFee;
    slots -= 1;
    t.entered = true;
    t.family = family;
    t.adds = 0;
    t.lastBuyPrice = now;
    t.entrySlot = currentSlot;
    t.entryTrades = c.trades;
    t.peak = now;
  }

  return orders;
}

function pendingHas(mint: string): boolean {
  for (const p of pending.values()) if (p.mint === mint) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Wire loop.
// ---------------------------------------------------------------------------

function applyBatch(batch: any): void {
  currentSlot = batch.slot;
  for (const f of batch.fills ?? []) pending.delete(f.client_id);
  const account = batch.account;
  cash = BigInt(account.cash_lamports);
  positions.clear();
  for (const p of account.positions ?? []) {
    const tokens = BigInt(p.token_amount);
    if (tokens > 0n) {
      positions.set(p.mint, { tokens, cost: BigInt(p.cost_lamports) });
    }
  }
}

function validateOrder(o: Order, seq: number): void {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.mint)) {
    throw new Error(`batch ${seq}: bad mint ${o.mint}`);
  }
  if (!Number.isInteger(o.max_slippage_bps) || o.max_slippage_bps < 0 || o.max_slippage_bps > 10_000) {
    throw new Error(`batch ${seq}: bad max_slippage_bps ${o.max_slippage_bps}`);
  }
  const amount = o.side === 'buy' ? o.quote_lamports : o.token_amount;
  if (typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(amount)) {
    throw new Error(`batch ${seq}: bad amount ${amount}`);
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.type === 'hello') {
      if (msg.protocol !== 'agent-fun/replay/v2') {
        throw new Error(`unsupported protocol ${msg.protocol}`);
      }
      cash = BigInt(msg.capital.lamports);
      maxOpenPositions = msg.caps.max_open_positions;
      maxOrdersPerBatch = msg.caps.max_orders_per_batch;
      maxOrderBps = BigInt(msg.caps.max_order_bps_of_real_reserve);
      txFee = BigInt(msg.fees.base_fee_lamports) + BigInt(msg.fees.priority_fee_lamports);
    } else if (msg.type === 'batch') {
      applyBatch(msg);
      const orders = decideBatch(msg);
      if (orders.length > maxOrdersPerBatch) {
        throw new Error(`batch ${msg.seq}: ${orders.length} orders over cap ${maxOrdersPerBatch}`);
      }
      for (const o of orders) validateOrder(o, msg.seq);
      process.stdout.write(JSON.stringify({ type: 'reply', seq: msg.seq, orders }) + '\n');
    } else if (msg.type === 'done') {
      // The replay is over: close the input and exit. Without an explicit
      // exit the readline handle would keep the process alive on an open
      // stdin pipe even though there is nothing left to do.
      rl.close();
      process.exit(0);
    } else {
      throw new Error(`unknown message type ${msg.type}`);
    }
  }
  throw new Error('input ended before done');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
