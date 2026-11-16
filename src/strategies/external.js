// Strategies run by an EXTERNAL engine (e.g. freqtrade dry-run on a VM) whose paper results are
// pushed to POST /api/ingest. They enter the same lifecycle/promotion pipeline.
// Register one like:
//   { id: 'ft_btc_trend_v1', family: 'ft_btc_trend', version: 1, external: true, engine: 'freqtrade',
//     cadence: 'fast', name: 'freqtrade BTC 추세 (외부)', market: 'crypto', timeframe: '1h',
//     universe: ['KRW-BTC'], benchSym: 'KRW-BTC', researchOnly: false, priorTrials: 0, description: '...' }
export const EXTERNAL_STRATEGIES = [];
