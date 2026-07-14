import { runDaily } from './pipeline.js';
import { log } from './util.js';

runDaily()
  .then((summary) => {
    if (summary.skipped) {
      log('skipped:', summary.reason);
      process.exit(0);
    }
    const s = summary.stocks, c = summary.crypto;
    log(
      `done. stocks: ${s ? `${s.picks.length} picks from ${s.universe} universe` : 'failed'}; ` +
        `crypto: ${c ? `${c.picks.length} picks from ${c.universe} universe` : 'failed'}` +
        (summary.errors.length ? `; errors: ${summary.errors.join(' | ')}` : '')
    );
    process.exit(summary.errors.length && !s && !c ? 1 : 0);
  })
  .catch((e) => {
    log('daily run crashed:', e.stack ?? e.message);
    process.exit(1);
  });
