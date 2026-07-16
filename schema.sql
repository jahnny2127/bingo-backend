-- =====================================================================
-- Bingo Live — database schema (virtual/play currency, no real money)
-- Target: PostgreSQL 13+ (works as-is on Supabase / Neon / Railway / RDS)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Players — one row per Telegram user
-- ---------------------------------------------------------------------
CREATE TABLE players (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT UNIQUE NOT NULL,
  username      TEXT,
  first_name    TEXT,
  last_name     TEXT,
  main_wallet   NUMERIC(12,2) NOT NULL DEFAULT 0,     -- winnings (virtual points)
  play_wallet   NUMERIC(12,2) NOT NULL DEFAULT 1000,  -- starting play balance (virtual points)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Rounds — one row per game round at a given stake
-- ---------------------------------------------------------------------
CREATE TYPE round_status AS ENUM ('waiting', 'active', 'completed', 'cancelled');

CREATE TABLE rounds (
  id                 BIGSERIAL PRIMARY KEY,
  game_code          TEXT UNIQUE NOT NULL,
  stake              NUMERIC(12,2) NOT NULL,
  status             round_status NOT NULL DEFAULT 'waiting',
  players_count      INT NOT NULL DEFAULT 0,     -- distinct players holding a card
  cards_sold         INT NOT NULL DEFAULT 0,      -- total cards sold (max 2/player)
  derash             NUMERIC(12,2) NOT NULL DEFAULT 0,  -- prize pool for this round
  countdown_ends_at  TIMESTAMPTZ,
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rounds_status_stake ON rounds(status, stake);

-- ---------------------------------------------------------------------
-- Round cards — the 1..600 card(s) each player selected for a round
-- card_layout is stored so the exact 5x5 grid is auditable/replayable
-- ---------------------------------------------------------------------
CREATE TABLE round_cards (
  id           BIGSERIAL PRIMARY KEY,
  round_id     BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id    BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  card_number  INT NOT NULL CHECK (card_number BETWEEN 1 AND 600),
  card_layout  JSONB NOT NULL,
  is_winner    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, card_number)
);

CREATE INDEX idx_round_cards_round ON round_cards(round_id);
CREATE INDEX idx_round_cards_player ON round_cards(player_id);

-- ---------------------------------------------------------------------
-- Round calls — the sequence of numbers called during a round (1..75)
-- ---------------------------------------------------------------------
CREATE TABLE round_calls (
  id          BIGSERIAL PRIMARY KEY,
  round_id    BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  call_order  INT NOT NULL,
  number      INT NOT NULL CHECK (number BETWEEN 1 AND 75),
  called_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, call_order),
  UNIQUE (round_id, number)
);

CREATE INDEX idx_round_calls_round ON round_calls(round_id);

-- ---------------------------------------------------------------------
-- Transactions — full ledger of every wallet change (virtual points)
-- ---------------------------------------------------------------------
CREATE TYPE tx_type    AS ENUM ('stake_debit', 'win_credit', 'bonus_credit', 'admin_adjustment');
CREATE TYPE wallet_kind AS ENUM ('main', 'play');

CREATE TABLE transactions (
  id             BIGSERIAL PRIMARY KEY,
  player_id      BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  round_id       BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  type           tx_type NOT NULL,
  wallet         wallet_kind NOT NULL,
  amount         NUMERIC(12,2) NOT NULL,   -- positive = credit, negative = debit
  balance_after  NUMERIC(12,2) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_player ON transactions(player_id);

-- ---------------------------------------------------------------------
-- Round winners — which card(s) won, how, and the payout given
-- ---------------------------------------------------------------------
CREATE TYPE win_type AS ENUM ('row', 'col', 'corners', 'diag');

CREATE TABLE round_winners (
  id             BIGSERIAL PRIMARY KEY,
  round_id       BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id      BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  card_number    INT NOT NULL,
  win_type       win_type NOT NULL,
  win_detail     JSONB,             -- e.g. {"row":2} or {"col":"B"} or {"dir":"down"} — lets the UI highlight the exact line
  payout_amount  NUMERIC(12,2) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_round_winners_round ON round_winners(round_id);
CREATE INDEX idx_round_winners_player ON round_winners(player_id);
