-- family-invest-paper-v2 schema. PAPER TRADING ONLY.
-- There are no broker/exchange credentials, account numbers or order tables for real money.

-- Market data. t: daily = KST date label as UTC-midnight epoch seconds; hourly = bar start epoch seconds.
CREATE TABLE IF NOT EXISTS candles (
  market TEXT NOT NULL,          -- 'krx' | 'crypto'
  tf TEXT NOT NULL,              -- '1d' | '1h'
  sym TEXT NOT NULL,
  t INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
  src TEXT NOT NULL,
  PRIMARY KEY (market, tf, sym, t)
) WITHOUT ROWID;

-- Small key/value store: cursors, readiness markers, dynamic universe, config.
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS data_health (
  source TEXT PRIMARY KEY,       -- e.g. 'upbit:1h', 'krx:etf', 'naver'
  last_ok INTEGER, last_err INTEGER, err TEXT,
  ok_count INTEGER NOT NULL DEFAULT 0, err_count INTEGER NOT NULL DEFAULT 0
);

-- One virtual account per strategy and mode ('paper' = forward paper ledger, 'bt' = in-worker backtest).
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,           -- '<strategy_id>:paper' | '<strategy_id>:bt'
  strategy_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'bt')),
  engine TEXT NOT NULL DEFAULT 'builtin',  -- 'builtin' | external engine name (e.g. 'freqtrade')
  state TEXT NOT NULL,           -- JSON engine state (cash, positions, pending virtual orders, peak, ...)
  start_after INTEGER,           -- first processed bar must be > start_after (forward-only paper)
  last_t INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fills (
  run_id TEXT NOT NULL, t INTEGER NOT NULL, seq INTEGER NOT NULL,
  sym TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty REAL NOT NULL, price REAL NOT NULL, gross REAL NOT NULL,
  fee REAL NOT NULL, tax REAL NOT NULL, pnl REAL NOT NULL,
  reason TEXT NOT NULL, cash REAL NOT NULL,
  PRIMARY KEY (run_id, t, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS equity (
  run_id TEXT NOT NULL, t INTEGER NOT NULL,
  equity REAL NOT NULL, cash REAL NOT NULL, invested REAL NOT NULL, bench REAL NOT NULL,
  PRIMARY KEY (run_id, t)
) WITHOUT ROWID;

-- Backtest summaries. kind: 'wf' (walk-forward OOS, local heavy runner), 'grid' (variants),
-- 'worker' (in-worker chunked re-run). curve = downsampled JSON points.
CREATE TABLE IF NOT EXISTS backtests (
  strategy_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
  created_at INTEGER NOT NULL, summary TEXT NOT NULL, curve TEXT,
  PRIMARY KEY (strategy_id, kind)
);

-- Lifecycle: 백테스트 → 모의 검증 → 실거래 가능(소액) → (중단 → 모의 복귀)
CREATE TABLE IF NOT EXISTS lifecycle (
  strategy_id TEXT PRIMARY KEY,
  family TEXT NOT NULL, version INTEGER NOT NULL,
  stage TEXT NOT NULL, label TEXT NOT NULL, summary TEXT NOT NULL, checks TEXT NOT NULL,
  paper_since INTEGER,           -- start of the current paper confirmation window
  promoted_t INTEGER,            -- when it became 실거래 가능(소액)
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL, kind TEXT NOT NULL, strategy_id TEXT, message TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_pending ON events (notified, id);

-- Optional external signals (news / sentiment) for strategies; empty by default.
CREATE TABLE IF NOT EXISTS signals (
  sym TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL, note TEXT,
  PRIMARY KEY (sym, t, kind)
) WITHOUT ROWID;

-- FUTURE live module data model (NOT USED for orders in this release; no writer exists).
CREATE TABLE IF NOT EXISTS live_budgets (
  strategy_id TEXT PRIMARY KEY,
  frac REAL NOT NULL,            -- share of capital allowed for live trading (starts at 5%)
  budget_krw INTEGER NOT NULL,
  step INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'disabled', -- 'disabled' | 'eligible' | 'killed'
  note TEXT, updated_at INTEGER NOT NULL
);

-- Owner-only dashboard sessions (pattern adapted from my-little-kitchen).
CREATE TABLE IF NOT EXISTS owner_sessions (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS login_rate_limits (
  bucket TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0, window_started_at INTEGER NOT NULL, blocked_until INTEGER
);

-- 전략 운용 매니저 (meta-allocator) history: weekly target weights across strategies.
CREATE TABLE IF NOT EXISTS allocations (
  t INTEGER PRIMARY KEY,
  weights TEXT NOT NULL,   -- JSON {strategy_id: weight}
  notes TEXT NOT NULL      -- JSON {strategy_id: plain-Korean reason}
);

-- Non-price feed items (news titles, sentiment, market warnings, disclosures). Common schema.
CREATE TABLE IF NOT EXISTS feed_items (
  source TEXT NOT NULL, t INTEGER NOT NULL, sym TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (source, t, sym, payload)
);
CREATE INDEX IF NOT EXISTS feed_items_t ON feed_items (t);

-- Every AI prompt/response is stored for audit (AI 판단 전략 / 뉴스 거부권).
CREATE TABLE IF NOT EXISTS ai_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL, response TEXT, ok INTEGER NOT NULL, note TEXT
);
