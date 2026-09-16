const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const http = require('http');
const https = require('https');
const db = require('./database');

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


function notifyChannelWithPhoto(text, lot) {
  const channelId = process.env.CHANNEL_ID;
  const token = process.env.ADMIN_BOT_TOKEN;
  const botUsername = process.env.BOT_USERNAME || 'UCBidbot';
  if (!channelId || !token) return;

  // UC icon based on amount
  const icon = lot.uc >= 1800 ? 'https://i.imgur.com/crown.png' : lot.uc >= 660 ? 'https://i.imgur.com/diamond.png' : 'https://i.imgur.com/coin.png';

  // Send message with inline button to open bot
  const body = JSON.stringify({
    chat_id: channelId,
    text: text + `\n\n🔗 <a href="https://t.me/${botUsername}/auction">Открыть аукцион</a>`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '⚡ Участвовать', url: `https://t.me/${botUsername}/auction` }
      ]]
    }
  });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(options, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => {
      try { const r = JSON.parse(d); if (!r.ok) console.error('Channel photo notify error:', r.description); }
      catch(e) {}
    });
  });
  req.on('error', e => console.error('Channel photo error:', e.message));
  req.write(body); req.end();
}

function notifyChannel(text) {
  const channelId = process.env.CHANNEL_ID;
  const token = process.env.ADMIN_BOT_TOKEN;
  if (!channelId || !token) return;
  tgSend(token, channelId, text);
}

function notifyUser(userId, text, keyboard) {
  tgSend(process.env.USER_BOT_TOKEN, userId, text, keyboard);
}

function getLots() {
  return settings.lots || {
    '325':  { uc: 325,  prize: '325 UC',  marketPrice: 58000,  bidCoins: 1 },
    '660':  { uc: 660,  prize: '660 UC',  marketPrice: 115000, bidCoins: 2 },
    '1800': { uc: 1800, prize: '1800 UC', marketPrice: 300000, bidCoins: 4 }
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

function getAuctionState(telegramId) {
  const state = {
    active: false,
    waiting: true,
    voteSession: voteSession.active ? {
      active: true,
      votes: voteSession.votes,
      countdownEnd: voteSession.countdownEnd,
      required: settings.votesRequired || 10
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
  const lotButtons = Object.entries(lots).map(([key, lot]) => ({
    text: `${lot.prize} (0 голосов)`,
    lotKey: key
  }));

  broadcast({
    type: 'VOTE_STARTED',
    voteId: voteSession.id,
    lots: lotButtons,
    required: settings.votesRequired || 10
  });

  notifyChannel(
    `🗳 <b>Голосование за следующий аукцион!</b>\n\n` +
    `Выбери какой UC разыграть:\n` +
    Object.entries(lots).map(([k, l]) => `• ${l.prize}`).join('\n') +
    `\n\nОткрой аукцион и проголосуй! Нужно ${settings.votesRequired || 10} голосов.`
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
    const delay = (settings.auctionStartDelay || 300) * 1000;
    voteSession.countdownEnd = Date.now() + delay;

    broadcast({
      type: 'VOTE_WON',
      lotKey: winner[0],
      prize: lots[winner[0]].prize,
      startsIn: settings.auctionStartDelay || 300,
      countdownEnd: voteSession.countdownEnd
    });

    notifyChannel(
      `🏁 <b>${lots[winner[0]].prize} победил в голосовании!</b>\n\n` +
      `⏳ Аукцион начнётся через ${Math.floor((settings.auctionStartDelay || 300) / 60)} минут!\n` +
      `Готовьте коины! 🪙`
    );

    // Notify 5 min warning if delay > 5 min
    if (delay > 5 * 60 * 1000) {
      setTimeout(() => {
        notifyChannel(
          `⚡ <b>Аукцион на ${lots[winner[0]].prize} начнётся через 5 минут!</b>\n\nГотовьте коины! 🪙`
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

  // Reset myAuction stats
  // (stored in DB per user, reset on join)

  broadcast({ type: 'NEW_AUCTION', auction: getAuctionState() });
  startAuctionTimer();

  const lots = getLots();
  notifyChannelWithPhoto(
    `🔥 <b>Аукцион начался!</b>\n\n` +
    `🎁 Лот: <b>${lots[lotKey].prize}</b>\n` +
    `💰 Рыночная цена: ${lots[lotKey].marketPrice.toLocaleString('ru-RU')} сум\n` +
    `🪙 1 ставка = ${lots[lotKey].bidCoins || 1} коин(а) = ${(lots[lotKey].bidCoins||1) * (settings.coinCost||500)} сум\n\n` +
    `👉 Участвуй прямо сейчас!`,
    lots[lotKey]
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
      const minBids = settings.minBids || 20;
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

  auction = null;

  // Auto-start new vote session after 1 minute
  setTimeout(() => {
    if (!auction && !voteSession.active) startVoteSession();
  }, 60000);
}

// ============ WEBSOCKET ============
wss.on('connection', (ws) => {
  const client = { ws, userId: null };
  clients.add(client);

  sendTo(ws, { type: 'CONNECTED', auction: getAuctionState(), leaderboard });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e) { return; }
    const { type, telegramId, name } = msg;

    if (type === 'PING') { sendTo(ws, { type: 'PONG' }); return; }
    if (!telegramId) return;
    const id = String(telegramId);

    if (type === 'JOIN') {
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
      } catch(e) { console.error('JOIN error:', e.message); }
      return;
    }

    if (type === 'BID') {
      if (!auction || !auction.active) { sendTo(ws, { type: 'ERROR', message: 'Аукцион не активен' }); return; }
      try {
        const user = await db.getUser(id, name);
        if (user.coins <= 0) { sendTo(ws, { type: 'ERROR', message: 'Нет коинов! Купи в магазине.' }); return; }
        if (auction.leaderId === id) { sendTo(ws, { type: 'ERROR', message: 'Ты уже лидер! Жди ставку другого.' }); return; }

        const lotBidCoins = getLots()[auction.lotKey]?.bidCoins || 1;
        const coinCost = settings.coinCost || 500;
        const timerAdd = settings.timerAddPerBid || 10;
        const maxTimer = settings.timerSeconds || 30;

        if (user.coins < lotBidCoins) {
          sendTo(ws, { type: 'ERROR', message: `Нужно ${lotBidCoins} коинов для ставки! Купи в магазине.` });
          return;
        }
        await db.incrementUser(id, {
          coins: -lotBidCoins,
          myAuctionCoins: lotBidCoins,
          myAuctionSpent: coinCost * lotBidCoins,
          totalSpent: coinCost * lotBidCoins,
          totalBids: 1
        });

        auction.currentPrice += settings.bidIncrement || 100;
        auction.bidCount++;
        auction.leaderId = id;
        auction.leaderName = user.name;
        auction.timeLeft = Math.min(auction.timeLeft + timerAdd, maxTimer);

        const bidEntry = {
          userId: id, name: user.name, price: auction.currentPrice,
          time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        };
        auction.bidHistory.push(bidEntry);
        if (auction.bidHistory.length > 50) auction.bidHistory.shift();

        const updatedUser = await db.getUser(id);
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
      } catch(e) { console.error('BID error:', e.message); }
      return;
    }

    if (type === 'VOTE') {
      const result = await handleVote(id, msg.lotKey);
      sendTo(ws, { type: 'VOTE_RESULT', ...result });
      return;
    }

    if (type === 'BUY_REQUEST') {
      const { username, count, price } = msg;
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

  const user = await db.getUser(String(telegramId));
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const newPending = Math.max(0, user.ucPending - amount);
  const newWithdrawn = user.ucWithdrawn + amount;

  // Update win history statuses
  const winHistory = user.winHistory || [];
  let remaining = amount;
  for (const w of winHistory) {
    if (w.status === 'pending' && remaining > 0) { w.status = 'withdrawn'; remaining -= w.uc; }
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

app.post('/use-promo', async (req, res) => {
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
  const { telegramId, referralCode } = req.body;
  if (!telegramId || !referralCode) return res.status(400).json({ error: 'Обязательные поля' });

  const user = await db.getUser(String(telegramId));
  if (user.referredBy) return res.status(400).json({ error: 'Реферал уже использован' });

  const referrer = await db.getUserByReferral(referralCode);
  if (!referrer) return res.status(404).json({ error: 'Реферальный код не найден' });
  if (referrer.telegramId === String(telegramId)) return res.status(400).json({ error: 'Нельзя использовать свой код' });

  // Give bonus to both
  const bonus = 5; // coins
  await db.updateUser(String(telegramId), { referredBy: referralCode });
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
