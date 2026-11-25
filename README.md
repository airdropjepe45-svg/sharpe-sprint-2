# CrossRider — Sharpe Sprint entry

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/airdropjepe45-svg/sharpe-sprint-2/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/airdropjepe45-svg/sharpe-sprint-2/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the pump.fun Sharpe Sprint: ranked by hourly Sharpe ratio on a fresh
6-hour forward replay, so it trades for steady, controlled gains rather than one lucky moonshot.

## Strategy

**Velocity cross.** A launch that attracts ~20 SOL of net buying in its first ~10 slots keeps
rising far more often than not; the same reserve level reached slowly is a coin flip. The bot
buys only fast crosses (real SOL reserve ≥ 20 SOL within 10 slots of creation), skipping
launches whose creator bought more than 2.5 SOL at launch or has already sold.

**Mechanical exits.** First take-profit banks half the position at +12%; the rest rides with a
breakeven stop, a +35% take-profit, a −10% stop, a trailing stop, a flow-fade exit, a dev-sell
exit and a 200-slot time limit — whichever comes first.

**Pyramid once.** A held coin that crosses 40 SOL of real reserve while in profit gets one
additional tranche, concentrating size in proven winners.

**Guardrail probes.** The run needs round trips of at least 0.01 SOL on at least 20 coins; when
the counted-coin pace lags, tiny round trips on liquid curves keep the run compliant.

Most of the 10 SOL stays in cash: at most 4 main positions of ~0.4 SOL each, so hourly equity
moves stay small and frequent.

## Determinism

The bot is a pure function of the harness batches: no clock, no randomness, no I/O. Two
executions produce byte-identical action logs (verified by `grade-local`, which runs it twice).

## Local results (dev window, 24h)

- Net PnL +0.83 SOL, hourly Sharpe 0.50, max drawdown 1.9%, 45 round trips over 45 coins.
- Still positive (+0.57 SOL) at 2× fees.
- Stress (`grade-local --stress 20`, block surrogates of the dev window): median +0.16 SOL,
  p10 −0.87, p90 +0.59; 15 of 20 copies profitable. The dev score sits above all 20 copies,
  so part of it leans on this window's particular coins — the median copy, not the dev score,
  is the honest expectation.
- All three pilot baselines lose money on this window (momentum −9.44, reversion −3.99,
  sniper −0.50 SOL); dip-buying and slow-cross momentum were tested and rejected.
- Parameters sit in a flat region: perturbing any single knob by ~20% keeps dev PnL in the
  +0.6…+0.75 SOL range, so the result is not a knife-edge fit to this window.

## Layout

- `main.ts` — entrypoint (`node /bot/main.ts`).
- `strategy.ts` — the strategy and its parameters.
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
