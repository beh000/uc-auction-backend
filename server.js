const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const http = require('http');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ============ CONSTANTS ============
const COIN_COST = 500;        // 1 coin = 500 sum
const BID_INCREMENT = 100;    // price increase per bid
const MIN_BIDS = 20;
const MAX_DISCOUNT = 15000;
const MAX_TIMER_ADD = 30;

const LOTS = {
  '325':  { uc: 325,  prize: '325 UC',  marketPrice: 55000 },
  '660':  { uc: 660,  prize: '660 UC',  marketPrice: 96000 },
  '1800': { uc: 1800, prize: '1800 UC', marketPrice: 245000 }
};

// ============ STATE ============
const users = {};
const clients = new Set();
const auctionHistory = [];
let leaderboard = [];
let auctionTimer = null;
let auction = null;

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

function getUser(telegramId, name) {
  const id = String(telegramId);
  if (!users[id]) {
    users[id] = {
      id, name: name || 'Игрок',
      coins: 0,
      totalSpent: 0,
      // UC stats
      ucWon: 0,        // total UC won ever
      ucPending: 0,    // won but not yet withdrawn
      ucWithdrawn: 0,  // already received
      wins: 0,
      winHistory: [],
      myAuctionCoins: 0,
      myAuctionSpent: 0
    };
  }
  if (name && users[id].name !== name) users[id].name = name;
  return users[id];
}

function createAuction(lotKey) {
  const lot = LOTS[lotKey];
  if (!lot) return null;
  return {
    id: Date.now(),
    lotKey,
    prize: lot.prize,
    uc: lot.uc,
    marketPrice: lot.marketPrice,
    currentPrice: 100,
    timeLeft: 30,
    maxTime: 30,
    bidCount: 0,
    leaderId: null,
    leaderName: null,
    active: true,
    bidHistory: [],
    startedAt: Date.now()
  };
}

function getAuctionState(telegramId) {
  const id = telegramId ? String(telegramId) : null;
  const user = id ? users[id] : null;
  if (!auction) return { active: false, waiting: true };
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
    bidHistory: auction.bidHistory.slice(-8),
    myAuctionCoins: user ? user.myAuctionCoins : 0,
    myAuctionSpent: user ? user.myAuctionSpent : 0
  };
}

function updateLeaderboard() {
  leaderboard = Object.values(users)
    .filter(u => u.ucWon > 0)
    .sort((a, b) => b.ucWon - a.ucWon)
    .slice(0, 20)
    .map(u => ({ id: u.id, name: u.name, wins: u.wins, ucWon: u.ucWon }));
}

// ============ TELEGRAM ============
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
  req.write(body);
  req.end();
}

function notifyChannel(text) {
  tgSend(process.env.ADMIN_BOT_TOKEN, process.env.CHANNEL_ID, text);
}

function notifyUser(userId, text, keyboard) {
  tgSend(process.env.USER_BOT_TOKEN, userId, text, keyboard);
}

// ============ AUCTION LOGIC ============
function startAuctionTimer() {
  clearInterval(auctionTimer);
  auctionTimer = setInterval(() => {
    if (!auction || !auction.active) { clearInterval(auctionTimer); return; }
    auction.timeLeft = Math.max(0, auction.timeLeft - 1);
    broadcast({ type: 'TIMER', timeLeft: auction.timeLeft });
    if (auction.timeLeft <= 0) {
      if (auction.bidCount >= MIN_BIDS) {
        endAuction();
      } else {
        auction.timeLeft = 30;
        broadcast({ type: 'TIMER_RESET', message: `Нужно ещё ${MIN_BIDS - auction.bidCount} ставок`, timeLeft: 30 });
      }
    }
  }, 1000);
}

function endAuction() {
  clearInterval(auctionTimer);
  auctionTimer = null;
  auction.active = false;

  const winner = auction.leaderId ? users[auction.leaderId] : null;
  if (winner) {
    winner.wins++;
    winner.ucWon += auction.uc;
    winner.ucPending += auction.uc;
    winner.winHistory.unshift({
      prize: auction.prize,
      uc: auction.uc,
      finalPrice: auction.currentPrice,
      date: new Date().toLocaleDateString('ru-RU'),
      status: 'pending',
      timestamp: Date.now()
    });
    if (winner.winHistory.length > 20) winner.winHistory.pop();

    // Notify winner
    notifyUser(auction.leaderId,
      `🏆 <b>Поздравляем! Вы выиграли ${auction.prize}!</b>\n\n` +
      `💰 Итоговая цена: <b>${auction.currentPrice.toLocaleString('ru-RU')} сум</b>\n\n` +
      `📲 Для получения UC введите ваш <b>PUBG ID</b> (числовой ID из игры).\n\n` +
      `Откройте бота и введите ID в ответ.`
    );
  }

  // Notify admin
  const adminBot = process.env.ADMIN_BOT_TOKEN ? require('./admin-bot') : null;
  if (adminBot) {
    adminBot.notifyAdmin(
      `🏆 <b>Аукцион завершён!</b>\n\n` +
      `🎁 Приз: ${auction.prize}\n` +
      `👤 Победитель: ${auction.leaderName} (<code>${auction.leaderId}</code>)\n` +
      `💰 Итоговая цена: ${auction.currentPrice.toLocaleString('ru-RU')} сум\n` +
      `🎯 Ставок: ${auction.bidCount}\n\n` +
      `⏳ Ожидайте PUBG ID от победителя.`,
      [[
        { text: '🚀 Новый аукцион', callback_data: 'start_auction' },
        { text: '📊 Статистика', callback_data: 'stats' }
      ]]
    );
  }

  // Discounts for losers
  const discounts = {};
  Object.values(users).forEach(u => {
    if (u.myAuctionCoins > 0 && u.id !== auction.leaderId) {
      discounts[u.id] = { discount: MAX_DISCOUNT, finalPrice: auction.marketPrice - MAX_DISCOUNT };
    }
  });

  auctionHistory.unshift({
    id: auction.id, prize: auction.prize,
    winnerId: auction.leaderId, winnerName: auction.leaderName,
    finalPrice: auction.currentPrice, bidCount: auction.bidCount,
    date: new Date().toLocaleDateString('ru-RU'), timestamp: Date.now()
  });
  if (auctionHistory.length > 50) auctionHistory.pop();

  updateLeaderboard();

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

  // Reset auction coins for all
  Object.values(users).forEach(u => { u.myAuctionCoins = 0; u.myAuctionSpent = 0; });
  auction = null;
}

// ============ WEBSOCKET ============
wss.on('connection', (ws) => {
  const client = { ws, userId: null };
  clients.add(client);

  sendTo(ws, { type: 'CONNECTED', auction: getAuctionState(), leaderboard });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e) { return; }
    const { type, telegramId, name } = msg;

    if (type === 'PING') { sendTo(ws, { type: 'PONG' }); return; }
    if (!telegramId) return;
    const id = String(telegramId);

    if (type === 'JOIN') {
      client.userId = id;
      const user = getUser(id, name);
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
          winHistory: user.winHistory,
          myAuctionCoins: user.myAuctionCoins
        }
      });
      return;
    }

    if (type === 'BID') {
      if (!auction || !auction.active) { sendTo(ws, { type: 'ERROR', message: 'Аукцион не активен' }); return; }
      const user = getUser(id, name);
      if (user.coins <= 0) { sendTo(ws, { type: 'ERROR', message: 'Нет коинов! Купи в магазине.' }); return; }
      if (auction.leaderId === id) { sendTo(ws, { type: 'ERROR', message: 'Ты уже лидер! Жди ставку другого.' }); return; }

      user.coins--;
      user.myAuctionCoins++;
      user.myAuctionSpent += COIN_COST;
      user.totalSpent += COIN_COST;
      auction.currentPrice += BID_INCREMENT;
      auction.bidCount++;
      auction.leaderId = id;
      auction.leaderName = user.name;
      auction.timeLeft = Math.min(auction.timeLeft + 10, MAX_TIMER_ADD);

      const bidEntry = {
        userId: id, name: user.name, price: auction.currentPrice,
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      };
      auction.bidHistory.push(bidEntry);
      if (auction.bidHistory.length > 50) auction.bidHistory.shift();

      sendTo(ws, { type: 'BID_CONFIRMED', coinsLeft: user.coins, currentPrice: auction.currentPrice, myAuctionCoins: user.myAuctionCoins, timeLeft: auction.timeLeft });
      broadcast({ type: 'BID_PLACED', bid: bidEntry, currentPrice: auction.currentPrice, bidCount: auction.bidCount, leaderName: auction.leaderName, leaderId: auction.leaderId, timeLeft: auction.timeLeft });
      return;
    }

    if (type === 'BUY_REQUEST') {
      const { username, count, price } = msg;
      const user = getUser(id, name);
      const adminBot = process.env.ADMIN_BOT_TOKEN ? require('./admin-bot') : null;
      if (adminBot) {
        const uStr = username ? `@${username}` : 'нет username';
        adminBot.notifyAdmin(
          `🪙 <b>Заявка на коины</b>\n\n👤 ${name} (${uStr})\n🆔 <code>${id}</code>\n🪙 ${count} коинов\n💰 ${Number(price).toLocaleString('ru-RU')} сум`,
          [[
            { text: `✅ Зачислить ${count} коинов`, callback_data: `confirm_${id}_${count}` },
            { text: '❌ Отклонить', callback_data: `reject_${id}` }
          ]]
        );
        adminBot.pendingPayments[id] = { name, packCount: parseInt(count), packPrice: parseInt(price), timestamp: Date.now() };
      }
      sendTo(ws, { type: 'BUY_REQUEST_SENT' });
      return;
    }
  });

  ws.on('close', () => { clients.delete(client); });
  ws.on('error', () => { clients.delete(client); });
});

// ============ REST API ============
app.get('/', (req, res) => res.json({
  status: 'UC Auction running',
  auctionActive: auction ? auction.active : false,
  auctionLot: auction ? auction.prize : null,
  clients: clients.size, users: Object.keys(users).length
}));

app.get('/auction', (req, res) => res.json(getAuctionState()));
app.get('/leaderboard', (req, res) => res.json(leaderboard));
app.get('/history', (req, res) => res.json(auctionHistory.slice(0, 20)));

app.post('/start-auction', (req, res) => {
  const { lotKey, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  if (auction && auction.active) return res.status(400).json({ error: 'Аукцион уже идёт' });
  if (!LOTS[lotKey]) return res.status(400).json({ error: 'Неверный лот' });

  auction = createAuction(lotKey);
  Object.values(users).forEach(u => { u.myAuctionCoins = 0; u.myAuctionSpent = 0; });
  broadcast({ type: 'NEW_AUCTION', auction: getAuctionState() });
  startAuctionTimer();

  notifyChannel(
    `🔥 <b>Новый аукцион!</b>\n\n🎁 Лот: <b>${LOTS[lotKey].prize}</b>\n💰 Рыночная цена: ${LOTS[lotKey].marketPrice.toLocaleString('ru-RU')} сум\n🪙 1 ставка = 1 коин (500 сум)\n\n👉 Участвуй сейчас!`
  );

  res.json({ success: true, auction: getAuctionState() });
});

app.post('/stop-auction', (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  if (!auction || !auction.active) return res.status(400).json({ error: 'Нет активного аукциона' });
  endAuction();
  res.json({ success: true });
});

app.post('/add-coins', (req, res) => {
  const { telegramId, name, amount, adminKey } = req.body;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  if (!telegramId) return res.status(400).json({ error: 'telegramId обязателен' });
  const parsed = parseInt(amount);
  if (!parsed || parsed <= 0 || parsed > 10000) return res.status(400).json({ error: 'Неверное количество' });

  const user = getUser(String(telegramId), name);
  user.coins += parsed;

  clients.forEach(c => {
    if (c.userId === String(telegramId)) {
      sendTo(c.ws, { type: 'COINS_ADDED', amount: parsed, totalCoins: user.coins });
    }
  });

  res.json({ success: true, telegramId: String(telegramId), coins: user.coins });
});

// Mark UC as withdrawn (admin confirms delivery)
app.post('/mark-withdrawn', (req, res) => {
  const { telegramId, uc, adminKey } = req.body;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });

  const user = users[String(telegramId)];
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const amount = parseInt(uc);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Неверное количество UC' });

  user.ucPending = Math.max(0, user.ucPending - amount);
  user.ucWithdrawn += amount;

  // Update winHistory status
  let remaining = amount;
  for (const w of user.winHistory) {
    if (w.status === 'pending' && remaining > 0) {
      w.status = 'withdrawn';
      remaining -= w.uc;
    }
  }

  // Notify user via websocket
  clients.forEach(c => {
    if (c.userId === String(telegramId)) {
      sendTo(c.ws, {
        type: 'UC_WITHDRAWN',
        uc: amount,
        ucPending: user.ucPending,
        ucWithdrawn: user.ucWithdrawn
      });
    }
  });

  res.json({ success: true, ucPending: user.ucPending, ucWithdrawn: user.ucWithdrawn });
});

app.get('/user/:id', (req, res) => {
  const user = users[String(req.params.id)];
  if (!user) return res.status(404).json({ error: 'Не найден' });
  const { id, name, coins, totalSpent, wins, ucWon, ucPending, ucWithdrawn, winHistory, myAuctionCoins } = user;
  res.json({ id, name, coins, totalSpent, wins, ucWon, ucPending, ucWithdrawn, winHistory, myAuctionCoins });
});

app.get('/admin/users', (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  res.json(Object.values(users).map(({ id, name, coins, wins, ucWon, ucPending, totalSpent }) => ({ id, name, coins, wins, ucWon, ucPending, totalSpent })));
});

// ============ START ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UC Auction server on port ${PORT}`);

  if (process.env.ADMIN_BOT_TOKEN && process.env.ADMIN_CHAT_ID) {
    try { const ab = require('./admin-bot'); ab.poll(); console.log('Admin bot started'); }
    catch(e) { console.error('Admin bot error:', e.message); }
  }

  if (process.env.USER_BOT_TOKEN) {
    try { const ub = require('./user-bot'); ub.poll(); console.log('User bot started'); }
    catch(e) { console.error('User bot error:', e.message); }
  }
});
