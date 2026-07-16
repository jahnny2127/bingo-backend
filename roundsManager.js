const pool = require('./db');
const { generateCard, findWinInfo } = require('./rng');

const MIN_PLAYERS = 10;
const EXTRA_WAIT_SECONDS = 15;
const COUNTDOWN_SECONDS = 60;
const MAX_CARDS_PER_PLAYER = 2;
const CALL_INTERVAL_MS = 1400;
const HOUSE_CUT = 0.2;
const WINNER_DISPLAY_DELAY_MS = 5000; // mirrors the 5s celebration screen on the frontend

// In-memory timer handles, keyed by round id. NOTE: these live in process
// memory only — if the server restarts mid-round, timers are lost. For a
// production deployment, replace with a durable job queue (e.g. BullMQ)
// or a periodic reconciliation worker that resumes any 'waiting'/'active'
// round found in the DB without a live timer.
const timers = new Map();

function genGameCode() {
  return 'BGL' + Math.floor(1000 + Math.random() * 9000) + 'X';
}

async function getOrCreateWaitingRound(stake) {
  const existing = await pool.query(
    `SELECT * FROM rounds WHERE status = 'waiting' AND stake = $1 ORDER BY created_at DESC LIMIT 1`,
    [stake]
  );
  if (existing.rows.length) return existing.rows[0];

  const countdownEndsAt = new Date(Date.now() + COUNTDOWN_SECONDS * 1000);
  const inserted = await pool.query(
    `INSERT INTO rounds (game_code, stake, status, countdown_ends_at)
     VALUES ($1, $2, 'waiting', $3) RETURNING *`,
    [genGameCode(), stake, countdownEndsAt]
  );
  const round = inserted.rows[0];
  scheduleRoundCheck(round.id, COUNTDOWN_SECONDS * 1000);
  return round;
}

function scheduleRoundCheck(roundId, delayMs) {
  clearTimer(roundId);
  const handle = setTimeout(() => evaluateRoundStart(roundId).catch(console.error), delayMs);
  timers.set(roundId, handle);
}

function clearTimer(roundId) {
  const h = timers.get(roundId);
  if (h) clearTimeout(h);
  timers.delete(roundId);
}

async function evaluateRoundStart(roundId) {
  const { rows } = await pool.query(`SELECT * FROM rounds WHERE id = $1`, [roundId]);
  const round = rows[0];
  if (!round || round.status !== 'waiting') return;

  const distinctPlayers = await pool.query(
    `SELECT COUNT(DISTINCT player_id) AS c FROM round_cards WHERE round_id = $1`,
    [roundId]
  );
  const playersCount = Number(distinctPlayers.rows[0].c);

  if (playersCount < MIN_PLAYERS) {
    const countdownEndsAt = new Date(Date.now() + EXTRA_WAIT_SECONDS * 1000);
    await pool.query(`UPDATE rounds SET countdown_ends_at = $1 WHERE id = $2`, [countdownEndsAt, roundId]);
    scheduleRoundCheck(roundId, EXTRA_WAIT_SECONDS * 1000);
    return;
  }

  await startRound(round, playersCount);
}

async function startRound(round, playersCount) {
  const cardsRes = await pool.query(`SELECT * FROM round_cards WHERE round_id = $1`, [round.id]);
  const cards = cardsRes.rows;
  const cardsByPlayer = new Map();
  for (const c of cards) {
    if (!cardsByPlayer.has(c.player_id)) cardsByPlayer.set(c.player_id, []);
    cardsByPlayer.get(c.player_id).push(c);
  }

  // Debit stake for every participating player (Play Wallet first, then Main Wallet for any shortfall).
  for (const [playerId, playerCards] of cardsByPlayer) {
    const cost = playerCards.length * Number(round.stake);
    await debitForStake(playerId, cost, round.id);
  }

  const cardsSold = cards.length;
  const derash = cardsSold * Number(round.stake) * (1 - HOUSE_CUT);

  await pool.query(
    `UPDATE rounds SET status='active', players_count=$1, cards_sold=$2, derash=$3, started_at=now() WHERE id=$4`,
    [playersCount, cardsSold, derash, round.id]
  );

  runCallingLoop(round.id, round.stake);
}

async function debitForStake(playerId, cost, roundId) {
  if (cost <= 0) return;
  const { rows } = await pool.query(`SELECT * FROM players WHERE id = $1 FOR UPDATE`, [playerId]);
  const player = rows[0];
  if (!player) return;

  let playWallet = Number(player.play_wallet);
  let mainWallet = Number(player.main_wallet);

  const fromPlay = Math.min(playWallet, cost);
  const shortfall = cost - fromPlay;

  playWallet -= fromPlay;
  mainWallet = Math.max(0, mainWallet - shortfall);

  await pool.query(`UPDATE players SET play_wallet=$1, main_wallet=$2, updated_at=now() WHERE id=$3`, [
    playWallet,
    mainWallet,
    playerId,
  ]);

  if (fromPlay > 0) {
    await pool.query(
      `INSERT INTO transactions (player_id, round_id, type, wallet, amount, balance_after)
       VALUES ($1,$2,'stake_debit','play',$3,$4)`,
      [playerId, roundId, -fromPlay, playWallet]
    );
  }
  if (shortfall > 0) {
    await pool.query(
      `INSERT INTO transactions (player_id, round_id, type, wallet, amount, balance_after)
       VALUES ($1,$2,'stake_debit','main',$3,$4)`,
      [playerId, roundId, -shortfall, mainWallet]
    );
  }
}

async function creditMainWallet(playerId, amount, roundId) {
  const { rows } = await pool.query(`SELECT * FROM players WHERE id = $1 FOR UPDATE`, [playerId]);
  const player = rows[0];
  if (!player) return;
  const newMain = Number(player.main_wallet) + amount;
  await pool.query(`UPDATE players SET main_wallet=$1, updated_at=now() WHERE id=$2`, [newMain, playerId]);
  await pool.query(
    `INSERT INTO transactions (player_id, round_id, type, wallet, amount, balance_after)
     VALUES ($1,$2,'win_credit','main',$3,$4)`,
    [playerId, roundId, amount, newMain]
  );
}

function shuffledPool() {
  const arr = Array.from({ length: 75 }, (_, i) => i + 1);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function runCallingLoop(roundId, stake) {
  const pool75 = shuffledPool();
  let idx = 0;
  let callOrder = 0;
  const calledSet = new Set();

  const handle = setInterval(async () => {
    try {
      const { rows } = await pool.query(`SELECT status FROM rounds WHERE id=$1`, [roundId]);
      if (!rows.length || rows[0].status !== 'active') {
        clearInterval(handle);
        return;
      }

      if (idx >= pool75.length) {
        clearInterval(handle);
        await endRound(roundId, []); // exhausted with no winner
        return;
      }

      const number = pool75[idx++];
      callOrder++;
      calledSet.add(number);
      await pool.query(
        `INSERT INTO round_calls (round_id, call_order, number) VALUES ($1,$2,$3)`,
        [roundId, callOrder, number]
      );

      const cardsRes = await pool.query(
        `SELECT * FROM round_cards WHERE round_id=$1 AND is_winner=false`,
        [roundId]
      );
      const winners = [];
      for (const card of cardsRes.rows) {
        const info = findWinInfo(card.card_layout, calledSet);
        if (info) winners.push({ card, info });
      }

      if (winners.length > 0) {
        clearInterval(handle);
        await endRound(roundId, winners);
      }
    } catch (err) {
      console.error('calling loop error', err);
      clearInterval(handle);
    }
  }, CALL_INTERVAL_MS);
}

async function endRound(roundId, winners) {
  const { rows } = await pool.query(`SELECT * FROM rounds WHERE id=$1`, [roundId]);
  const round = rows[0];
  const derash = Number(round.derash);

  if (winners.length > 0) {
    const share = derash / winners.length;
    for (const { card, info } of winners) {
      const winDetail = {};
      if (info.type === 'row') winDetail.row = info.row;
      if (info.type === 'col') winDetail.col = info.col;
      if (info.type === 'diag') winDetail.dir = info.dir;

      await pool.query(`UPDATE round_cards SET is_winner=true WHERE id=$1`, [card.id]);
      await pool.query(
        `INSERT INTO round_winners (round_id, player_id, card_number, win_type, win_detail, payout_amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [roundId, card.player_id, card.card_number, info.type, JSON.stringify(winDetail), share]
      );
      await creditMainWallet(card.player_id, share, roundId);
    }
  }

  await pool.query(`UPDATE rounds SET status='completed', ended_at=now() WHERE id=$1`, [roundId]);
  clearTimer(roundId);

  // Open the next waiting round for this stake after the celebration window.
  setTimeout(() => {
    getOrCreateWaitingRound(round.stake).catch(console.error);
  }, WINNER_DISPLAY_DELAY_MS);
}

async function selectCard(roundId, playerId, cardNumber) {
  const roundRes = await pool.query(`SELECT * FROM rounds WHERE id=$1`, [roundId]);
  const round = roundRes.rows[0];
  if (!round) throw new Error('round not found');
  if (round.status !== 'waiting') throw new Error('round is no longer accepting cards');

  const taken = await pool.query(
    `SELECT 1 FROM round_cards WHERE round_id=$1 AND card_number=$2`,
    [roundId, cardNumber]
  );
  if (taken.rows.length) throw new Error('card already taken');

  const mineRes = await pool.query(
    `SELECT COUNT(*) AS c FROM round_cards WHERE round_id=$1 AND player_id=$2`,
    [roundId, playerId]
  );
  const mine = Number(mineRes.rows[0].c);
  if (mine >= MAX_CARDS_PER_PLAYER) throw new Error('max cards reached');

  const playerRes = await pool.query(`SELECT * FROM players WHERE id=$1`, [playerId]);
  const player = playerRes.rows[0];
  if (!player) throw new Error('player not found');

  const cost = (mine + 1) * Number(round.stake);
  const available = Number(player.play_wallet) + Number(player.main_wallet);
  if (cost > available) throw new Error('insufficient balance in Play Wallet and Main Wallet');

  const layout = generateCard(cardNumber);
  const inserted = await pool.query(
    `INSERT INTO round_cards (round_id, player_id, card_number, card_layout)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [roundId, playerId, cardNumber, JSON.stringify(layout)]
  );
  return inserted.rows[0];
}

async function deselectCard(roundId, playerId, cardNumber) {
  const roundRes = await pool.query(`SELECT status FROM rounds WHERE id=$1`, [roundId]);
  if (!roundRes.rows.length || roundRes.rows[0].status !== 'waiting') {
    throw new Error('round is no longer accepting changes');
  }
  await pool.query(
    `DELETE FROM round_cards WHERE round_id=$1 AND player_id=$2 AND card_number=$3`,
    [roundId, playerId, cardNumber]
  );
}

async function getRoundState(roundId, playerId) {
  const roundRes = await pool.query(`SELECT * FROM rounds WHERE id=$1`, [roundId]);
  const round = roundRes.rows[0];
  if (!round) throw new Error('round not found');

  let livePlayers = round.players_count;
  if (round.status === 'waiting') {
    const liveRes = await pool.query(
      `SELECT COUNT(DISTINCT player_id) AS c FROM round_cards WHERE round_id = $1`,
      [roundId]
    );
    livePlayers = Number(liveRes.rows[0].c);
  }

  const callsRes = await pool.query(
    `SELECT number FROM round_calls WHERE round_id=$1 ORDER BY call_order ASC`,
    [roundId]
  );
  const calledNumbers = callsRes.rows.map((r) => r.number);

  const takenRes = await pool.query(`SELECT card_number FROM round_cards WHERE round_id=$1`, [roundId]);
  const takenCardNumbers = takenRes.rows.map((r) => r.card_number);

  let myCards = [];
  if (playerId) {
    const mineRes = await pool.query(
      `SELECT card_number, card_layout, is_winner FROM round_cards WHERE round_id=$1 AND player_id=$2`,
      [roundId, playerId]
    );
    myCards = mineRes.rows;
  }

  const winnersRes = await pool.query(
    `SELECT rw.*, p.telegram_id, p.username FROM round_winners rw
     JOIN players p ON p.id = rw.player_id WHERE rw.round_id=$1`,
    [roundId]
  );

  return {
    round,
    livePlayers,
    minPlayers: MIN_PLAYERS,
    calledNumbers,
    currentCall: calledNumbers[calledNumbers.length - 1] || null,
    takenCardNumbers,
    myCards,
    winners: winnersRes.rows,
  };
}

module.exports = {
  MIN_PLAYERS,
  getOrCreateWaitingRound,
  selectCard,
  deselectCard,
  getRoundState,
};
