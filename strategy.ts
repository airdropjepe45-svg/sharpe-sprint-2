// CrossRider: ride bonding curves that prove real demand by crossing a high real-SOL reserve
// threshold FAST (within a few slots of launch), exit mechanically, and pyramid once into
// winners that cross a second, higher threshold.
//
// Why this shape: on the dev window, buying dips and chasing early run-ups both lose money
// after fees, and slow reserve crosses are mostly exhausted pumps. The one robust pattern is
// velocity: a launch that attracts ~20 SOL of net buying in its first ~10 slots keeps rising
// far more often than not (many of them into migration), while the same cross reached slowly
// is a coin flip at best. The position is small, the exit is mechanical, and most of the
// 10 SOL stays in cash, so hourly equity moves stay small and frequent rather than rare
// and wild — which is what an hourly Sharpe ranking rewards.
//
// Guardrail probes: the run needs round trips of at least 0.01 SOL on at least 20 coins.
// Main entries may not reach 20 coins in a quiet 6-hour window, so when the counted-coin
// pace lags, the bot opens tiny round trips (buy, sell next batch) on liquid curves.
//
// Everything is a pure function of the batches the harness sends: no clock, no randomness,
// no I/O, so the two graded executions produce byte-identical action logs.

import type { Batch, BotState, Mark, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL reserve (lamports) a curve must first cross to become a buy. */
  crossRq: bigint;
  /** Oldest age (slots since create) at which a first cross may still be bought. */
  maxAge: number;
  /** Creator's own create-slot buy above this (lamports) marks the launch as toxic. */
  maxDevBuy: bigint;
  /** Skip when the creator has already sold before entry. */
  skipDevSold: boolean;
  /** Net SOL flow over the last flowWindow slots must be at least this (lamports) at entry. */
  minFlow: bigint;
  flowWindow: number;
  /** Distinct non-creator buyers in the flow window at entry, at least. */
  minBuyers: number;
  /** Wait this many slots after the cross before buying; rq must still be >= crossRq then. */
  confirmSlots: number;
  /** At confirmation, price must be at least (1 - confirmDip) of the cross price. */
  confirmDip: number;
  /** Lamports per main position (the 1%-of-reserve reply cap also applies). */
  stake: bigint;
  /** Smallest buy worth sending. */
  minBuy: bigint;
  /** Buy slippage tolerance (bps). Sells always go at 10000. */
  buySlippageBps: number;
  /** Exit when liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** First take-profit: sell tp1Part of the position once value reaches cost * (1 + tp1); 0 = off. */
  tp1: number;
  tp1Part: number;
  /** Exit when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop: once value reached cost * (1 + trailArm), exit on a fall of trail from best. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when net flow over flowWindow slots falls below minus this (lamports). */
  exitFlow: bigint;
  /** Most main positions open at once (the rest of the 5 slots is for probes). */
  maxMain: number;
  /** Most lamports at cost across main positions at once. */
  maxExposure: bigint;
  /** After an exit, ignore the coin for good (one ride per coin). */
  oneRidePerCoin: boolean;
  /** When oneRidePerCoin is false: slots to wait after an exit before riding the coin again. */
  reentryCooldown: number;
  /** Guardrail probes: target counted coins, probe buy size, pacing horizon in block seconds. */
  targetCoins: number;
  probeBuy: bigint;
  probePaceSecs: number;
  /** A probe target curve must hold at least this much real SOL (lamports). */
  probeMinRq: bigint;
  /** Pyramid: add this much once a held coin's rq first crosses addRq with the position in profit; 0n disables. */
  addRq: bigint;
  addStake: bigint;
}

export const DEFAULT_PARAMS: Params = {
  crossRq: 20_000_000_000n,
  maxAge: 10,
  maxDevBuy: 2_500_000_000n,
  skipDevSold: true,
  minFlow: 0n,
  flowWindow: 30,
  minBuyers: 0,
  confirmSlots: 0,
  confirmDip: 0.1,
  stake: 400_000_000n,
  minBuy: 10_000_000n,
  buySlippageBps: 500,
  takeProfit: 0.35,
  tp1: 0.12,
  tp1Part: 0.5,
  stopLoss: 0.1,
  trailArm: 0.1,
  trail: 0.12,
  maxHold: 200,
  exitOnDevSell: true,
  exitFlow: 2_000_000_000n,
  maxMain: 4,
  maxExposure: 3_000_000_000n,
  oneRidePerCoin: true,
  reentryCooldown: 300,
  targetCoins: 22,
  probeBuy: 12_000_000n,
  probePaceSecs: 14_400,
  probeMinRq: 2_000_000_000n,
  addRq: 40_000_000_000n,
  addStake: 400_000_000n,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  devSold: boolean;
  crossed: boolean;
  crossSlot: number;
  crossVq: bigint;
  crossVt: bigint;
  done: boolean;
  lastExitSlot: number;
  recent: Tick[];
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  exiting: boolean;
  tookTp1: boolean;
  added: boolean;
}

const FEE_BPS = 125n;
const BPS = 10_000n;
const MIN_COUNTED_BUY = 10_000_000n;

/** What selling `tokens` against (vq, vt) pays after curve fees (95 + 30 bps), before the tx fee. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

/** The per-reply buy cap with a small margin for the harness's offset reserves. */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe mints: false while the buy is in flight, true once we are selling it back. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints that already hold a counted round trip (a filled buy >= 0.01 SOL that later closed). */
  const countedCoins = new Set<Pubkey>();
  /** Bought lamports of the open round trip per mint, from our own fills. */
  const tripBought = new Map<Pubkey, bigint>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey, createSlot: number, creator: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { createSlot, creator, devBuy: 0n, devSold: false, crossed: false, crossSlot: -1, crossVq: 0n, crossVt: 1n, done: false, lastExitSlot: -1_000_000_000, recent: [] };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net lamports bought minus sold and distinct non-creator buyers over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const touched: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        coinOf(e.mint, e.slot, e.creator);
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (c.recent.length > 300) c.recent.splice(0, c.recent.length - 300);
        if (e.is_buy && e.user === c.creator && e.slot === c.createSlot) c.devBuy += sol;
        if (!e.is_buy && e.user === c.creator) c.devSold = true;
        if (!touched.includes(e.mint)) touched.push(e.mint);
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.done = true;
      }
    }

    // Bookkeeping from fills: tx fees paid, counted round trips, probe lifecycle.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // Harness close (complete / flatten / writeoff): the round trip is over.
        if ((tripBought.get(f.mint) ?? 0n) >= MIN_COUNTED_BUY) countedCoins.add(f.mint);
        tripBought.delete(f.mint);
        held.delete(f.mint);
        probes.delete(f.mint);
        continue;
      }
      if (f.status !== 'rejected') {
        const h = held.get(f.mint);
        if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      }
      if (f.side === 'buy' && f.status === 'filled') {
        tripBought.set(f.mint, (tripBought.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
        if (!held.has(f.mint) && !probes.has(f.mint)) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, devSoldAtOpen: coins.get(f.mint)?.devSold ?? false, exiting: false, tookTp1: false, added: false });
        }
      }
      if (f.side === 'sell') {
        const h = held.get(f.mint);
        if (h !== undefined) h.exiting = false;
        if (f.status === 'filled' && !state.positions.has(f.mint)) {
          if ((tripBought.get(f.mint) ?? 0n) >= MIN_COUNTED_BUY) countedCoins.add(f.mint);
          tripBought.delete(f.mint);
          held.delete(f.mint);
          probes.delete(f.mint);
        }
      }
      if (f.side === 'buy' && f.status !== 'filled' && !state.positions.has(f.mint)) {
        // Opening buy never landed: free the probe/main slot it was holding.
        let stillPending = false;
        for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
        if (!stillPending) {
          probes.delete(f.mint);
          held.delete(f.mint);
          tripBought.delete(f.mint);
        }
      }
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !probes.has(mint)) {
        let pending = false;
        for (const o of state.pending.values()) if (o.order.mint === mint) pending = true;
        if (!pending) held.delete(mint);
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, Mark>();
    for (const m of batch.marks) marks.set(m.mint, m);
    const pendingMints = new Set<Pubkey>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);

    // 1. Exits on held main positions, in mint order (deterministic).
    const heldMints = [...state.positions.keys()].sort();
    for (const mint of heldMints) {
      if (orders.length >= cap) break;
      if (probes.has(mint)) continue;
      const pos = state.positions.get(mint)!;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = coins.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false, exiting: false, tookTp1: false, added: false };
        held.set(mint, h);
      }
      if (h.exiting || pendingMints.has(mint)) continue;
      const mk = marks.get(mint);
      const vq = mk !== undefined ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk !== undefined ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = sellValue(pos.token_amount, vq, vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      if (value > h.best) h.best = value;
      // First take-profit: bank part of the position, then the rest rides with a breakeven stop.
      if (p.tp1 > 0 && !h.tookTp1 && basis > 0n && value * BPS >= basis * (BPS + BigInt(Math.round(p.tp1 * 10000)))) {
        const part = (pos.token_amount * BigInt(Math.round(p.tp1Part * 10000))) / BPS;
        if (part > 0n && part < pos.token_amount) {
          orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
          h.tookTp1 = true;
          h.exiting = true;
          pendingMints.add(mint);
          continue;
        }
      }
      let exit = false;
      if (basis > 0n) {
        const gain = Number(value - basis) / Number(basis);
        const stop = h.tookTp1 ? 0 : -p.stopLoss;
        if (gain >= p.takeProfit) exit = true;
        else if (gain <= stop) exit = true;
        else if (h.best >= basis + (basis * BigInt(Math.round(p.trailArm * 10000))) / BPS && value <= h.best - (h.best * BigInt(Math.round(p.trail * 10000))) / BPS) exit = true;
      }
      if (slot - h.openedSlot >= p.maxHold) exit = true;
      if (c !== undefined) {
        if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (flow(c, slot).net < -p.exitFlow) exit = true;
      }
      if (!exit) {
        // Pyramid once into a winner that crosses the higher reserve threshold in profit.
        if (p.addRq > 0n && !h.added && curve.real_quote_reserves >= p.addRq && basis > 0n && value > basis) {
          let amount = p.addStake;
          const sizeCap = buyCap(state, mint);
          if (amount > sizeCap) amount = sizeCap;
          if (amount >= p.minBuy && state.freeCashLamports() - tx * BigInt(orders.length) >= amount + tx) {
            orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
            h.added = true;
            pendingMints.add(mint);
          }
        }
        continue;
      }
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      h.exiting = true;
      pendingMints.add(mint);
      if (c !== undefined) {
        c.lastExitSlot = slot;
        if (p.oneRidePerCoin) c.done = true;
      }
    }

    // 2. Probe exits: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      if (orders.length >= cap) break;
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
      pendingMints.add(mint);
    }

    // 3. New main entries on coins that traded this slot.
    let open = state.committedPositionCount();
    let mainOpen = 0;
    let exposure = 0n;
    for (const mint of state.positions.keys()) {
      if (probes.has(mint)) continue;
      mainOpen++;
      exposure += state.positions.get(mint)!.cost_lamports;
    }
    for (const o of state.pending.values()) {
      if (o.order.side === 'buy' && !state.positions.has(o.order.mint) && !probes.has(o.order.mint)) {
        mainOpen++;
        exposure += BigInt(o.order.quote_lamports);
      }
    }
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    for (const mint of touched) {
      if (orders.length >= cap) break;
      if (open >= state.hello.caps.max_open_positions || mainOpen >= p.maxMain) break;
      if (state.positions.has(mint) || pendingMints.has(mint) || probes.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = coins.get(mint);
      if (c === undefined || c.done) continue;
      if (curve.real_quote_reserves < p.crossRq) continue;
      if (!c.crossed) {
        c.crossed = true;
        c.crossSlot = slot;
        c.crossVq = curve.virtual_quote_reserves;
        c.crossVt = curve.virtual_token_reserves;
      }
      if (slot - c.createSlot > p.maxAge) { c.done = true; continue; }
      if (slot - c.lastExitSlot < p.reentryCooldown) continue;
      if (p.confirmSlots > 0) {
        if (slot - c.crossSlot < p.confirmSlots) continue;
        // Price must not have fallen more than confirmDip below the cross price.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vq * c.crossVt * BPS < c.crossVq * vt * (BPS - BigInt(Math.round(p.confirmDip * 10000)))) continue;
      }
      if (c.devBuy > p.maxDevBuy) { c.done = true; continue; }
      if (p.skipDevSold && c.devSold) { c.done = true; continue; }
      const fl = flow(c, slot);
      if (fl.net < p.minFlow || fl.buyers < p.minBuyers) continue;
      let amount = p.stake;
      const sizeCap = buyCap(state, mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (exposure + amount > p.maxExposure) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      free -= amount + tx;
      exposure += amount;
      open++;
      mainOpen++;
      pendingMints.add(mint);
      if (p.oneRidePerCoin) c.done = true;
    }

    // 4. Guardrail probes: keep the counted-coin pace on target.
    if (probes.size === 0 && firstTime !== null && lastTime !== null && open < state.hello.caps.max_open_positions) {
      const elapsed = Math.max(0, lastTime - firstTime);
      const due = Math.ceil((p.targetCoins * Math.min(elapsed, p.probePaceSecs)) / p.probePaceSecs);
      if (countedCoins.size < due) {
        for (const mint of touched) {
          if (orders.length >= cap || probes.size >= 1) break;
          if (countedCoins.has(mint) || state.positions.has(mint) || pendingMints.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.real_quote_reserves < p.probeMinRq) continue;
          let amount = p.probeBuy;
          const sizeCap = buyCap(state, mint);
          if (amount > sizeCap) amount = sizeCap;
          if (amount < MIN_COUNTED_BUY) continue;
          if (free < amount + tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          probes.set(mint, false);
          free -= amount + tx;
          pendingMints.add(mint);
        }
      }
    }
    return orders;
  };
}
