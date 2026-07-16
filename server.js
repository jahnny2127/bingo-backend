require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const { verifyTelegramInitData } = require('./telegramAuth');
const roundsManager = require('./roundsManager');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SKIP_TELEGRAM_VERIFY = process.env.SKIP_TELEGRAM_VERIFY === 'true'; // local dev only

// ---------------------------------------------------------------------
// Auth — verify Telegram WebApp initData, upsert the player row
// ---------------------------------------------------------------------
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    let tgUser;

    if (SKIP_TELEGRAM_VERIFY) {
      // DEV ONLY: lets you test with curl/Postman without real Telegram data.
      tgUser = req.body.devUser || { id: 123456, username: 'dev_user', first_name: 'Dev' };
    } else {
      const result = verifyTelegramInitData(initData, BOT_TOKEN);
      if (!result.ok) return res.status(401).json({ error: result.error });
      tgUser = result.user;
    }

    if (!tgUser || !tgUser.id) return res.status(400).json({ error: 'no telegram user in initData' });

    const upsert = await pool.query(
      `INSERT INTO players (telegram_id, username, first_name, last_name)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username=$2, first_name=$3, last_name=$4, updated_at=now()
       RETURNING *`,
      [tgUser.id, tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null]
    );

    res.json({ player: upsert.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------
app.get('/api/wallet/:playerId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, main_wallet, play_wallet FROM players WHERE id=$1`,
      [req.params.playerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'player not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/players/:playerId/transactions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM transactions WHERE player_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.playerId]
    );
    res.json({ transactions: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/players/:playerId/rounds', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.game_code, r.stake, r.status, r.derash, r.started_at, r.ended_at,
              rc.card_number, rc.is_winner
       FROM round_cards rc
       JOIN rounds r ON r.id = rc.round_id
       WHERE rc.player_id=$1
       ORDER BY r.created_at DESC LIMIT 50`,
      [req.params.playerId]
    );
    res.json({ rounds: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------
app.get('/api/rounds/active', async (req, res) => {
  try {
    const stake = Number(req.query.stake);
    if (!stake) return res.status(400).json({ error: 'stake query param required' });
    const round = await roundsManager.getOrCreateWaitingRound(stake);
    const state = await roundsManager.getRoundState(round.id, req.query.player_id);
    res.json(state);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/rounds/:roundId/state', async (req, res) => {
  try {
    const state = await roundsManager.getRoundState(req.params.roundId, req.query.player_id);
    res.json(state);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rounds/:roundId/select-card', async (req, res) => {
  try {
    const { player_id, card_number } = req.body;
    const card = await roundsManager.selectCard(req.params.roundId, player_id, card_number);
    res.json({ card });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rounds/:roundId/deselect-card', async (req, res) => {
  try {
    const { player_id, card_number } = req.body;
    await roundsManager.deselectCard(req.params.roundId, player_id, card_number);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bingo Live backend listening on :${PORT}`));
