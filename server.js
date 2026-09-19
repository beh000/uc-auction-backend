const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./database');

const CHANNEL_BANNER_PATH = path.join(__dirname, 'assets', 'channel-banner.jpg');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ============ STATE (runtime only) ============
const clients = new Set(); // { ws, userId }
let settings = {};
let auction = null;
let auctionTimer = null;
let leaderboard = [];

// Voting state
let voteSession = {
  id: null,        // unique vote session id
  active: false,
  votes: {},       // { lotKey: count }
  voterIds: new Set(),
  startCountdown: null, // setTimeout handle
  countdownEnd: null    // timestamp when auction starts
};

// ============ INIT ============
async function init() {
  settings = await db.getSettings();
  leaderboard = await db.getLeaderboard();
  console.log('Settings loaded, leaderboard loaded');
  scheduleBackups();
}

// The self-hosted Mongo has no automatic backups (Atlas had them; this
// doesn't) — so the app takes its own daily dump and ships it to object
// storage. First run is delayed so it doesn't compete with startup, then
// repeats every 24h. A failed backup is logged, never lets it crash the app.
function scheduleBackups() {
  const { backupDatabase } = require('./backup');
  const run = async () => {
    try {
      await backupDatabase(await db.connect());
    } catch (e) {
      console.error('Backup failed:', e.message);
    }
  };
  setTimeout(run, 60 * 1000);
  setInterval(run, 24 * 60 * 60 * 1000);
}

// ============ HELPERS ============
function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => {
    try { if (c.ws.readyState === 1) c.ws.send(msg); } catch(e) {}
  });
}

function sendTo(ws, data) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(data)); } catch(e) {}
}

// Verifies Telegram WebApp initData against the bot token, per Telegram's own
// signature scheme. Without this, any client could claim to be any telegramId
// (the app previously trusted whatever id the browser sent), letting someone
// bid, win prizes or collect referral bonuses as another real user.
function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const pairs = [];
    for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(hash))) return null;
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch (e) {
    return null;
  }
}

function tgSend(token, chatId, text, keyboard) {
  if (!token || !chatId) return;
  const body = JSON.stringify({
    chat_id: chatId, text, parse_mode: 'HTML',
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(options);
  req.on('error', () => {});
  req.write(body); req.end();
}


// Every channel post gets the "open bot" button — the old plain-text path
// (vote start/won) never had one; only the auction-start message did.
// Pass withPhoto to attach the local banner image as the post's photo.
// The banner is uploaded directly (multipart), not linked by URL — Telegram
// fetching a hotlinked URL was the previous "Content not viewable" failure.
async function notifyChannel(text, withPhoto) {
  const channelId = process.env.CHANNEL_ID;
  const token = process.env.ADMIN_BOT_TOKEN;
  const botUsername = process.env.BOT_USERNAME || 'ucbid_uz_bot';
  if (!channelId || !token) return;

  const keyboard = [[{ text: '⚡ Открыть аукцион', url: `https://t.me/${botUsername}/auction` }]];

  if (!withPhoto) { tgSend(token, channelId, text, keyboard); return; }

  try {
    const form = new FormData();
    form.append('chat_id', String(channelId));
    form.append('caption', text);
    form.append('parse_mode', 'HTML');
    form.append('reply_markup', JSON.stringify({ inline_keyboard: keyboard }));
    form.append('photo', new Blob([fs.readFileSync(CHANNEL_BANNER_PATH)]), 'banner.jpg');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    const r = await res.json();
    if (!r.ok) { console.error('Channel photo notify error:', r.description); tgSend(token, channelId, text, keyboard); }
  } catch (e) {
    console.error('Channel photo error:', e.message);
    tgSend(token, channelId, text, keyboard);
  }
}

function notifyUser(userId, text, keyboard) {
  tgSend(process.env.USER_BOT_TOKEN, userId, text, keyboard);
}

function getLots() {
  return settings.lots || {
    '325':  { uc: 325,  prize: '325 UC',  marketPrice: 55000,  bidCoins: 1 },
    '660':  { uc: 660,  prize: '660 UC',  marketPrice: 96000,  bidCoins: 2 },
    '1800': { uc: 1800, prize: '1800 UC', marketPrice: 245000, bidCoins: 4 }
  };
}

function createAuction(lotKey) {
  const lots = getLots();
  const lot = lots[lotKey];
  if (!lot) return null;
  return {
    id: Date.now(),
    lotKey,
    prize: lot.prize,
    uc: lot.uc,
    marketPrice: lot.marketPrice,
    currentPrice: 100,
    timeLeft: settings.timerSeconds || 30,
    maxTime: settings.timerSeconds || 30,
    bidCount: 0,
    leaderId: null,
    leaderName: null,
    active: true,
    bidHistory: [],
    startedAt: Date.now()
  };
}

function getLotButtons() {
  return Object.entries(getLots()).map(([key, lot]) => ({
    text: `${lot.prize} (${voteSession.votes[key] || 0} голосов)`,
    lotKey: key
  }));
}

function getAuctionState(telegramId) {
  const state = {
    active: false,
    waiting: true,
    voteSession: voteSession.active ? {
      active: true,
      votes: voteSession.votes,
      countdownEnd: voteSession.countdownEnd,
      required: settings.votesRequired || 10,
      lots: getLotButtons()
    } : null
  };
  if (!auction) return state;

  return {
    id: auction.id,
    lotKey: auction.lotKey,
    prize: auction.prize,
    uc: auction.uc,
    marketPrice: auction.marketPrice,
    currentPrice: auction.currentPrice,
    timeLeft: auction.timeLeft,
    maxTime: auction.maxTime,
    bidCount: auction.bidCount,
    leaderName: auction.leaderName,
    leaderId: auction.leaderId,
    active: auction.active,
    bidCoins: getLots()[auction.lotKey]?.bidCoins || 1,
    coinCost: settings.coinCost || 500,
    bidHistory: auction.bidHistory.slice(-8),
    voteSession: null
  };
}

// ============ VOTING ============
function startVoteSession() {
  voteSession = {
    id: Date.now().toString(),
    active: true,
    votes: {},
    voterIds: new Set(),
    startCountdown: null,
    countdownEnd: null
  };

  const lots = getLots();

  broadcast({
    type: 'VOTE_STARTED',
    voteId: voteSession.id,
    lots: getLotButtons(),
    required: settings.votesRequired || 10,
    startDelay: settings.auctionStartDelay ?? 300
  });

  notifyChannel(
    `🗳 <b>Голосование за следующий аукцион!</b>\n\n` +
    `Выбери какой UC разыграть:\n` +
    Object.entries(lots).map(([k, l]) => `• ${l.prize}`).join('\n') +
    `\n\nОткрой аукцион и проголосуй! Нужно ${settings.votesRequired || 10} голосов.`,
    true
  );
}

async function handleVote(telegramId, lotKey) {
  if (!voteSession.active) return { ok: false, error: 'Голосование не активно' };
  if (voteSession.voterIds.has(String(telegramId))) return { ok: false, error: 'Ты уже проголосовал!' };

  const lots = getLots();
  if (!lots[lotKey]) return { ok: false, error: 'Неверный лот' };

  // Save vote
  await db.addVote(telegramId, lotKey, voteSession.id);
  voteSession.voterIds.add(String(telegramId));
  voteSession.votes[lotKey] = (voteSession.votes[lotKey] || 0) + 1;

  const required = settings.votesRequired || 10;
  const totalVotes = Object.values(voteSession.votes).reduce((a, b) => a + b, 0);

  broadcast({
    type: 'VOTE_UPDATE',
    votes: voteSession.votes,
    totalVotes,
    required
  });

  // Check if any lot reached required votes
  const winner = Object.entries(voteSession.votes).find(([k, v]) => v >= required);
  if (winner && !voteSession.startCountdown) {
    // ?? (not ||) — an admin can deliberately set this to 0 (start right after
    // the vote) via the settings menu, and 0 is falsy so || would silently
    // revert it to 300.
    const startDelay = settings.auctionStartDelay ?? 300;
    const delay = startDelay * 1000;
    voteSession.countdownEnd = Date.now() + delay;

    broadcast({
      type: 'VOTE_WON',
      lotKey: winner[0],
      prize: lots[winner[0]].prize,
      startsIn: startDelay,
      countdownEnd: voteSession.countdownEnd
    });

    notifyChannel(
      `🏁 <b>${lots[winner[0]].prize} победил в голосовании!</b>\n\n` +
      `⏳ Аукцион начнётся через ${Math.floor(startDelay / 60)} минут!\n` +
      `Готовьте коины! 🪙`,
      true
    );

    // Notify 5 min warning if delay > 5 min
    if (delay > 5 * 60 * 1000) {
      setTimeout(() => {
        notifyChannel(
          `⚡ <b>Аукцион на ${lots[winner[0]].prize} начнётся через 5 минут!</b>\n\nГотовьте коины! 🪙`,
          true
        );
        broadcast({ type: 'AUCTION_SOON', prize: lots[winner[0]].prize, seconds: 300 });
      }, delay - 5 * 60 * 1000);
    }

    voteSession.startCountdown = setTimeout(async () => {
      await launchAuction(winner[0]);
    }, delay);
  }

  return { ok: true, votes: voteSession.votes, totalVotes, required };
}

async function launchAuction(lotKey) {
  if (auction && auction.active) return;

  voteSession.active = false;
  if (voteSession.startCountdown) clearTimeout(voteSession.startCountdown);

  auction = createAuction(lotKey);

  // Reset everyone's "spent in current auction" counter so the post-auction
  // consolation discount reflects this auction only, not a lifetime total.
  try { await db.resetMyAuctionCoins(); } catch(e) { console.error('resetMyAuctionCoins error:', e.message); }

  broadcast({ type: 'NEW_AUCTION', auction: getAuctionState() });
  startAuctionTimer();

  const lots = getLots();
  notifyChannel(
    `🔥 <b>Аукцион начался!</b>\n\n` +
    `🎁 Лот: <b>${lots[lotKey].prize}</b>\n` +
    `💰 Рыночная цена: ${lots[lotKey].marketPrice.toLocaleString('ru-RU')} сум\n` +
    `🪙 1 ставка = ${lots[lotKey].bidCoins || 1} коин(а) = ${(lots[lotKey].bidCoins||1) * (settings.coinCost||500)} сум\n\n` +
    `👉 Участвуй прямо сейчас!`,
    true
  );
}

// ============ AUCTION TIMER ============
function startAuctionTimer() {
  clearInterval(auctionTimer);
  auctionTimer = setInterval(async () => {
    if (!auction || !auction.active) { clearInterval(auctionTimer); return; }
    auction.timeLeft = Math.max(0, auction.timeLeft - 1);
    broadcast({ type: 'TIMER', timeLeft: auction.timeLeft });
    if (auction.timeLeft <= 0) {
      // ?? — an admin can deliberately set this to 0 (end on time alone, no
      // minimum bid count) via the settings menu; || would silently undo that.
      const minBids = settings.minBids ?? 20;
      if (auction.bidCount >= minBids) {
        await endAuction();
      } else {
        auction.timeLeft = settings.timerSeconds || 30;
        broadcast({ type: 'TIMER_RESET', message: `Нужно ещё ${minBids - auction.bidCount} ставок`, timeLeft: auction.timeLeft });
      }
    }
  }, 1000);
}

async function endAuction() {
  clearInterval(auctionTimer);
  auctionTimer = null;
  auction.active = false;

  // Everything below can throw (DB calls) — without the try/finally, an error
  // partway through left `auction` non-null forever, since the `auction = null`
  // and "schedule next vote" lines below never ran. That silently froze the
  // whole auction/vote cycle until the process was restarted.
  try {

  if (auction.leaderId) {
    const user = await db.getUser(auction.leaderId);
    const levelInfo = db.calculateLevel(user.wins + 1, user.totalBids);

    await db.updateUser(auction.leaderId, {
      wins: user.wins + 1,
      ucWon: user.ucWon + auction.uc,
      ucPending: user.ucPending + auction.uc,
      level: levelInfo.level,
      xp: levelInfo.xp,
      $push: {
        winHistory: {
          $each: [{
            prize: auction.prize,
            uc: auction.uc,
            finalPrice: auction.currentPrice,
            date: new Date().toLocaleDateString('ru-RU'),
            status: 'pending',
            timestamp: Date.now()
          }],
          $position: 0,
          $slice: 20
        }
      }
    });

    notifyUser(auction.leaderId,
      `🏆 <b>Поздравляем! Вы выиграли ${auction.prize}!</b>\n\n` +
      `💰 Итоговая цена: <b>${auction.currentPrice.toLocaleString('ru-RU')} сум</b>\n\n` +
      `📲 Введите ваш <b>PUBG ID</b> в боте для получения UC.`
    );

    try {
      const userBot = require('./user-bot');
      userBot.askWinnerPubgId(auction.leaderId, auction.uc, auction.prize);
    } catch(e) {}
  }

  // Save auction to DB
  await db.saveAuction({
    id: auction.id, lotKey: auction.lotKey, prize: auction.prize,
    winnerId: auction.leaderId, winnerName: auction.leaderName,
    finalPrice: auction.currentPrice, bidCount: auction.bidCount,
    startedAt: new Date(auction.startedAt), endedAt: new Date()
  });

  leaderboard = await db.getLeaderboard();

  const discounts = {};
  // We'll let frontend handle discount display based on myAuctionCoins

  broadcast({
    type: 'AUCTION_ENDED',
    winnerId: auction.leaderId,
    winnerName: auction.leaderName,
    finalPrice: auction.currentPrice,
    prize: auction.prize,
    uc: auction.uc,
    marketPrice: auction.marketPrice,
    discounts,
    leaderboard
  });

  try {
    const adminBot = require('./admin-bot');
    adminBot.notifyAdmin(
      `🏆 <b>Аукцион завершён!</b>\n\n` +
      `🎁 ${auction.prize}\n` +
      `👤 Победитель: ${auction.leaderName} (<code>${auction.leaderId}</code>)\n` +
      `💰 ${auction.currentPrice.toLocaleString('ru-RU')} сум\n` +
      `🎯 Ставок: ${auction.bidCount}\n\n` +
      `⏳ Ожидайте PUBG ID.`,
      [[
        { text: '🗳 Новое голосование', callback_data: 'start_vote' },
        { text: '📊 Статистика', callback_data: 'stats' }
      ]]
    );
  } catch(e) {}

  } catch(e) {
    console.error('endAuction error:', e.message);
  } finally {
    auction = null;
    // Auto-start new vote session after 1 minute
    setTimeout(() => {
      if (!auction && !voteSession.active) startVoteSession();
    }, 60000);
  }
}

// ============ WEBSOCKET ============
wss.on('connection', (ws) => {
  const client = { ws, userId: null };
  clients.add(client);

  sendTo(ws, { type: 'CONNECTED', auction: getAuctionState(), leaderboard });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e) { return; }
    const { type } = msg;

    if (type === 'PING') { sendTo(ws, { type: 'PONG' }); return; }

    if (type === 'JOIN') {
      const claimedId = msg.telegramId ? String(msg.telegramId) : null;
      const name = msg.name;
      if (!claimedId) return;

      // Trust the id embedded in Telegram's signed initData, if present, over
      // whatever the client claims. A numeric (real) id without a valid
      // signature is rejected outright — otherwise anyone could bid, win or
      // collect referral bonuses as any other Telegram user.
      let id = null;
      const verifiedUser = msg.initData ? verifyTelegramInitData(msg.initData, process.env.USER_BOT_TOKEN) : null;
      if (verifiedUser) {
        id = String(verifiedUser.id);
      } else if (claimedId.startsWith('g_')) {
        id = claimedId; // anonymous guest session (e.g. testing outside Telegram) — no identity to spoof
      } else {
        sendTo(ws, { type: 'ERROR', message: 'Не удалось подтвердить личность Telegram' });
        return;
      }

      client.userId = id;
      try {
        const user = await db.getUser(id, name);
        const levelInfo = db.calculateLevel(user.wins, user.totalBids || 0);
        sendTo(ws, {
          type: 'JOINED',
          auction: getAuctionState(id),
          leaderboard,
          user: {
            coins: user.coins,
            totalSpent: user.totalSpent,
            wins: user.wins,
            ucWon: user.ucWon,
            ucPending: user.ucPending,
            ucWithdrawn: user.ucWithdrawn,
            winHistory: user.winHistory || [],
            myAuctionCoins: user.myAuctionCoins || 0,
            level: levelInfo.level,
            levelTitle: levelInfo.title,
            xp: levelInfo.xp,
            nextXp: levelInfo.nextXp,
            referralCode: user.referralCode,
            referrals: user.referrals || 0
          }
        });
      } catch(e) {
        console.error('JOIN error:', e.message);
        sendTo(ws, { type: 'ERROR', message: 'Ошибка сервера, попробуй перезайти' });
      }
      return;
    }

    // Every message beyond JOIN/PING acts on whichever id was verified at
    // JOIN time — never on an id supplied in the message itself.
    const id = client.userId;
    if (!id) { sendTo(ws, { type: 'ERROR', message: 'Сначала подключись (JOIN)' }); return; }

    if (type === 'BID') {
      if (!auction || !auction.active) { sendTo(ws, { type: 'ERROR', message: 'Аукцион не активен' }); return; }
      const now = Date.now();
      if (client.lastBidAt && now - client.lastBidAt < 300) return; // basic anti-spam/anti-bot throttle
      client.lastBidAt = now;
      try {
        if (auction.leaderId === id) { sendTo(ws, { type: 'ERROR', message: 'Ты уже лидер! Жди ставку другого.' }); return; }

        const lotBidCoins = getLots()[auction.lotKey]?.bidCoins || 1;
        const coinCost = settings.coinCost || 500;
        const timerAdd = settings.timerAddPerBid || 10;
        const maxTimer = settings.timerSeconds || 30;

        if (msg.name) await db.getUser(id, msg.name); // keep display name in sync

        // Atomic "coins >= cost, then deduct" — fixes a race where two quick
        // bids from the same user could both pass a stale balance check and
        // send coins negative.
        const updatedUser = await db.placeBid(id, lotBidCoins, coinCost * lotBidCoins);
        if (!updatedUser) {
          sendTo(ws, { type: 'ERROR', message: `Нужно ${lotBidCoins} коинов для ставки! Купи в магазине.` });
          return;
        }

        auction.currentPrice += settings.bidIncrement || 100;
        auction.bidCount++;
        auction.leaderId = id;
        auction.leaderName = updatedUser.name;
        auction.timeLeft = Math.min(auction.timeLeft + timerAdd, maxTimer);

        const bidEntry = {
          userId: id, name: updatedUser.name, price: auction.currentPrice,
          time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        };
        auction.bidHistory.push(bidEntry);
        if (auction.bidHistory.length > 50) auction.bidHistory.shift();

        sendTo(ws, {
          type: 'BID_CONFIRMED',
          coinsLeft: updatedUser.coins,
          currentPrice: auction.currentPrice,
          myAuctionCoins: updatedUser.myAuctionCoins,
          timeLeft: auction.timeLeft
        });
        broadcast({
          type: 'BID_PLACED', bid: bidEntry,
          currentPrice: auction.currentPrice, bidCount: auction.bidCount,
          leaderName: auction.leaderName, leaderId: auction.leaderId,
          timeLeft: auction.timeLeft
        });
      } catch(e) {
        console.error('BID error:', e.message);
        sendTo(ws, { type: 'ERROR', message: 'Ошибка сервера, попробуй ещё раз' });
      }
      return;
    }

    if (type === 'VOTE') {
      try {
        const result = await handleVote(id, msg.lotKey);
        sendTo(ws, { type: 'VOTE_RESULT', ...result });
      } catch(e) {
        console.error('VOTE error:', e.message);
        sendTo(ws, { type: 'VOTE_RESULT', ok: false, error: 'Ошибка сервера, попробуй ещё раз' });
      }
      return;
    }

    if (type === 'BUY_REQUEST') {
      const { username, count, price, name } = msg;
      try {
        const adminBot = require('./admin-bot');
        const uStr = username ? `@${username}` : 'нет username';
        adminBot.notifyAdmin(
          `🪙 <b>Заявка на коины</b>\n\n👤 ${name} (${uStr})\n🆔 <code>${id}</code>\n🪙 ${count} коинов\n💰 ${Number(price).toLocaleString('ru-RU')} сум`,
          [[
            { text: `✅ Зачислить ${count} коинов`, callback_data: `confirm_${id}_${count}` },
            { text: '❌ Отклонить', callback_data: `reject_${id}` }
          ]]
        );
        adminBot.pendingPayments[id] = { name, packCount: parseInt(count), packPrice: parseInt(price), timestamp: Date.now() };
      } catch(e) {}
      sendTo(ws, { type: 'BUY_REQUEST_SENT' });
      return;
    }
  });

  ws.on('close', () => { clients.delete(client); });
  ws.on('error', () => { clients.delete(client); });
});

// ============ REST API ============
app.get('/', (req, res) => res.json({
  status: 'UC Auction v3',
  auctionActive: auction ? auction.active : false,
  auctionLot: auction ? auction.prize : null,
  voteActive: voteSession.active,
  clients: clients.size
}));

app.get('/auction', (req, res) => res.json(getAuctionState()));
// Public pricing info — no admin key needed, it's just prices — so the bots
// and the Mini App can always show what the admin currently has configured
// instead of a value baked in at build time.
app.get('/prices', (req, res) => res.json({
  lots: getLots(),
  direct: settings.directPrices || {
    uc60:   { uc: 60,   price: 13000  },
    uc325:  { uc: 325,  price: 58000  },
    uc660:  { uc: 660,  price: 115000 },
    uc1800: { uc: 1800, price: 300000 }
  },
  // ?? — an admin can deliberately turn the consolation discount off (0),
  // which || would silently revert to 15000.
  maxDiscount: settings.maxDiscount ?? 15000,
  coinCost: settings.coinCost || 500,
  botUsername: process.env.BOT_USERNAME || 'ucbid_uz_bot'
}));
app.get('/leaderboard', (req, res) => res.json(leaderboard));
app.get('/history', async (req, res) => res.json(await db.getAuctionHistory()));
app.get('/settings', async (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  res.json(settings);
});

app.post('/update-setting', async (req, res) => {
  const { key, value, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  await db.setSetting(key, value);
  settings[key] = value;
  res.json({ success: true, key, value });
});

app.post('/start-vote', (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  if (auction && auction.active) return res.status(400).json({ error: 'Аукцион уже идёт' });
  if (voteSession.active) return res.status(400).json({ error: 'Голосование уже идёт' });
  startVoteSession();
  res.json({ success: true });
});

app.post('/start-auction', async (req, res) => {
  const { lotKey, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  if (auction && auction.active) return res.status(400).json({ error: 'Аукцион уже идёт' });
  const lots = getLots();
  if (!lots[lotKey]) return res.status(400).json({ error: 'Неверный лот' });
  await launchAuction(lotKey);
  res.json({ success: true, auction: getAuctionState() });
});

app.post('/stop-auction', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  if (!auction || !auction.active) return res.status(400).json({ error: 'Нет активного аукциона' });
  await endAuction();
  res.json({ success: true });
});

app.post('/add-coins', async (req, res) => {
  const { telegramId, name, amount, adminKey } = req.body;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  if (!telegramId) return res.status(400).json({ error: 'telegramId обязателен' });
  const parsed = parseInt(amount);
  if (!parsed || parsed <= 0 || parsed > 10000) return res.status(400).json({ error: 'Неверное количество' });

  await db.getUser(String(telegramId), name);
  await db.incrementUser(String(telegramId), { coins: parsed });
  const user = await db.getUser(String(telegramId));

  clients.forEach(c => {
    if (c.userId === String(telegramId)) {
      sendTo(c.ws, { type: 'COINS_ADDED', amount: parsed, totalCoins: user.coins });
    }
  });
  res.json({ success: true, telegramId: String(telegramId), coins: user.coins });
});

app.post('/mark-withdrawn', async (req, res) => {
  const { telegramId, uc, adminKey } = req.body;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  const amount = parseInt(uc);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Неверное количество UC' });

  const user = await db.findUser(String(telegramId));
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const newPending = Math.max(0, user.ucPending - amount);
  const newWithdrawn = user.ucWithdrawn + amount;

  // Update win history statuses — only mark an entry withdrawn once `amount`
  // fully covers it, so a partial payout can't get flagged as fully paid.
  const winHistory = user.winHistory || [];
  let remaining = amount;
  for (const w of winHistory) {
    if (w.status === 'pending' && remaining >= w.uc) { w.status = 'withdrawn'; remaining -= w.uc; }
  }

  await db.updateUser(String(telegramId), { ucPending: newPending, ucWithdrawn: newWithdrawn, winHistory });

  clients.forEach(c => {
    if (c.userId === String(telegramId)) {
      sendTo(c.ws, { type: 'UC_WITHDRAWN', uc: amount, ucPending: newPending, ucWithdrawn: newWithdrawn });
    }
  });
  res.json({ success: true, ucPending: newPending, ucWithdrawn: newWithdrawn });
});

// Promo codes
app.post('/create-promo', async (req, res) => {
  const { code, coins, maxUses, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  if (!code || !coins || !maxUses) return res.status(400).json({ error: 'code, coins, maxUses обязательны' });
  try {
    await db.createPromo(code, parseInt(coins), parseInt(maxUses));
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: 'Промокод уже существует' }); }
});

// Internal-only: called by user-bot.js on behalf of a Telegram-verified chat,
// never by the Mini App directly. Reuses ADMIN_KEY (already required for every
// other admin endpoint) rather than a new env var, so there's nothing extra to
// remember to configure on deploy — it still closes off direct internet calls
// with an arbitrary telegramId, since only server-side code has ADMIN_KEY.
function requireInternalKey(req, res) {
  if (!process.env.ADMIN_KEY || req.headers['x-internal-key'] !== process.env.ADMIN_KEY) {
    res.status(403).json({ error: 'Нет доступа' });
    return false;
  }
  return true;
}

app.post('/use-promo', async (req, res) => {
  if (!requireInternalKey(req, res)) return;
  const { code, telegramId } = req.body;
  if (!code || !telegramId) return res.status(400).json({ error: 'code и telegramId обязательны' });
  const result = await db.usePromo(code, telegramId);
  if (!result.ok) return res.status(400).json(result);

  await db.incrementUser(String(telegramId), { coins: result.coins });
  const user = await db.getUser(String(telegramId));
  clients.forEach(c => {
    if (c.userId === String(telegramId)) {
      sendTo(c.ws, { type: 'COINS_ADDED', amount: result.coins, totalCoins: user.coins });
    }
  });
  res.json({ success: true, coins: result.coins });
});

app.get('/promos', async (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  res.json(await db.listPromos());
});

app.delete('/promo/:code', async (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  await db.deletePromo(req.params.code);
  res.json({ success: true });
});

// Referral
app.post('/use-referral', async (req, res) => {
  if (!requireInternalKey(req, res)) return;
  const { telegramId, referralCode } = req.body;
  if (!telegramId || !referralCode) return res.status(400).json({ error: 'Обязательные поля' });

  await db.getUser(String(telegramId)); // ensure the user record exists before claiming

  const referrer = await db.getUserByReferral(referralCode);
  if (!referrer) return res.status(404).json({ error: 'Реферальный код не найден' });
  if (referrer.telegramId === String(telegramId)) return res.status(400).json({ error: 'Нельзя использовать свой код' });

  // Atomic claim (referredBy: null in the filter) — two concurrent calls for
  // the same user can't both win and both get paid; see claimReferral().
  const claimed = await db.claimReferral(telegramId, referralCode);
  if (!claimed) return res.status(400).json({ error: 'Реферал уже использован' });

  // Give bonus to both
  const bonus = 5; // coins
  await db.incrementUser(String(telegramId), { coins: bonus });
  await db.incrementUser(referrer.telegramId, { coins: bonus, referrals: 1 });

  // Notify referrer
  notifyUser(referrer.telegramId,
    `🎉 <b>По вашей реферальной ссылке зарегистрировался новый игрок!</b>\n\nВам начислено <b>${bonus} коинов</b> 🪙`
  );

  res.json({ success: true, bonus });
});

app.get('/admin/users', async (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  res.json(await db.getAllUsers());
});

app.get('/admin/stats', async (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  const users = await db.getAllUsers();
  const history = await db.getAuctionHistory(10);
  const totalRevenue = users.reduce((s, u) => s + (u.totalSpent || 0), 0);
  const totalCoinsLeft = users.reduce((s, u) => s + (u.coins || 0), 0);
  res.json({
    totalUsers: users.length,
    totalRevenue,
    totalCoinsLeft,
    totalAuctions: history.length,
    recentAuctions: history.slice(0, 5),
    topUsers: users.slice(0, 5)
  });
});

app.get('/user/:id', async (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  try {
    const user = await db.getUser(req.params.id);
    const { telegramId, name, coins, totalSpent, wins, ucWon, ucPending, ucWithdrawn, winHistory, level, referralCode, referrals } = user;
    res.json({ telegramId, name, coins, totalSpent, wins, ucWon, ucPending, ucWithdrawn, winHistory, level, referralCode, referrals });
  } catch(e) { res.status(404).json({ error: 'Не найден' }); }
});

// ============ START ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`UC Auction v3 on port ${PORT}`);
  try { await init(); } catch(e) { console.error('Init error:', e.message); }

  if (process.env.ADMIN_BOT_TOKEN && process.env.ADMIN_CHAT_ID) {
    try { const ab = require('./admin-bot'); ab.poll(); console.log('Admin bot ✅'); }
    catch(e) { console.error('Admin bot error:', e.message); }
  }
  if (process.env.USER_BOT_TOKEN) {
    try { const ub = require('./user-bot'); ub.poll(); console.log('User bot ✅'); }
    catch(e) { console.error('User bot error:', e.message); }
  }

  // Start vote session on launch if no auction
  setTimeout(() => {
    if (!auction && !voteSession.active) startVoteSession();
  }, 5000);
});

module.exports = { startVoteSession, launchAuction };
