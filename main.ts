// Sharpe Sprint entry: CrossRider — ride curves that cross a high real-SOL reserve threshold,
// exit mechanically, keep most of the capital in cash. Run by the grader as `node /bot/main.ts`;
// the SDK shim is vendored byte for byte in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const onBatch = createStrategy(DEFAULT_PARAMS);

await runBot({ onBatch });
