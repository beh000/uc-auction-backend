const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ============ CONSTANTS ============
const AUCTION_DURATION = 30;
const BID_COST = 2000;
const BID_INCREMENT = 100;
const MIN_BIDS = 20;
const MAX_DISCOUNT = 15000;
const MAX_TIMER_RESET = 30; // max seconds added per bid
const NEW_AUCTION_DELAY = 30000; // 30s between auctions

// ============ STATE ============
const users = {};
const clients = new Set();
let auctionTimer = null;
let newAuctionTimeout = null;

let auction = createAuction(1);

function createAuction(id) {
  return {
    id,
    prize: '660 UC',
    marketPrice: 96000,
    currentPrice: 100,
    timeLeft: AUCTION_DURATION,
    maxTime: AUCTION_DURATION,
    bidCount: 0,
    leaderId: null,
    leaderName: null,
    active: true,
    bidHistory: [],
    startedAt: Date.now()
  };
}

// ============ HELPERS ============
function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(client => {
    try {
      if (client.ws.readyState === 1) client.ws.send(msg);
    } catch(e) {}
  });
}

function sendTo(ws, data) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  } catch(e) {}
}

function getUser(telegramId, name) {
  // FIX: ensure telegramId is always a string
  const id = String(telegramId);
  if (!users[id]) {
    users[id] = {
      id,
      name: name || 'Игрок',
      bids: 0,
      totalSpent: 0,
      wins: 0,
      myAuctionBids: 0,
      myAuctionSpent: 0
    };
  }
  // FIX: update name if provided and different
  if (name && users[id].name !== name) users[id].name = name;
  return users[id];
}

function getAuctionState(telegramId) {
  const id = telegramId ? String(telegramId) : null;
  const user = id ? users[id] : null;
  return {
    id: auction.id,
    prize: auction.prize,
    marketPrice: auction.marketPrice,
    currentPrice: auction.currentPrice,
    timeLeft: auction.timeLeft,
    maxTime: auction.maxTime,
    bidCount: auction.bidCount,
    leaderName: auction.leaderName,
    leaderId: auction.leaderId,
    active: auction.active,
    bidHistory: auction.bidHistory.slice(-8),
    myAuctionBids: user ? user.myAuctionBids : 0,
    myAuctionSpent: user ? user.myAuctionSpent : 0
  };
}

// ============ AUCTION LOGIC ============
function startAuctionTimer() {
  clearInterval(auctionTimer);
  auctionTimer = setInterval(() => {
    if (!auction.active) {
      clearInterval(auctionTimer);
      return;
    }

    auction.timeLeft = Math.max(0, auction.timeLeft - 1);

    broadcast({ type: 'TIMER', timeLeft: auction.timeLeft });

    if (auction.timeLeft <= 0) {
      if (auction.bidCount >= MIN_BIDS) {
        endAuction();
      } else {
        // FIX: reset timer if not enough bids, don't end auction
        auction.timeLeft = AUCTION_DURATION;
        broadcast({
          type: 'TIMER_RESET',
          message: `Нужно ещё ${MIN_BIDS - auction.bidCount} ставок для завершения`,
          timeLeft: auction.timeLeft
        });
      }
    }
  }, 1000);
}

function endAuction() {
  clearInterval(auctionTimer);
  auctionTimer = null;
  auction.active = false;

  // FIX: safely increment wins only if user exists
  if (auction.leaderId && users[auction.leaderId]) {
    users[auction.leaderId].wins++;
  }

  // Calculate discounts for all participants
  const discounts = {};
  Object.values(users).forEach(u => {
    if (u.myAuctionSpent > 0 && u.id !== auction.leaderId) {
      const discount = Math.min(u.myAuctionSpent, MAX_DISCOUNT);
      discounts[u.id] = {
        spent: u.myAuctionSpent,
        discount,
        finalPrice: auction.marketPrice - discount
      };
    }
  });

  broadcast({
    type: 'AUCTION_ENDED',
    winnerId: auction.leaderId,
    winnerName: auction.leaderName,
    finalPrice: auction.currentPrice,
    prize: auction.prize,
    discounts
  });

  // FIX: clear previous timeout before setting new one
  if (newAuctionTimeout) clearTimeout(newAuctionTimeout);
  newAuctionTimeout = setTimeout(startNewAuction, NEW_AUCTION_DELAY);
}

function startNewAuction() {
  // Reset per-auction stats for all users
  Object.values(users).forEach(u => {
    u.myAuctionBids = 0;
    u.myAuctionSpent = 0;
  });

  auction = createAuction(auction.id + 1);

  broadcast({
    type: 'NEW_AUCTION',
    auction: getAuctionState()
  });

  startAuctionTimer();
}

// ============ WEBSOCKET ============
wss.on('connection', (ws) => {
  const client = { ws, userId: null };
  clients.add(client);

  // FIX: send current state immediately on connect
  sendTo(ws, {
    type: 'CONNECTED',
    auction: getAuctionState()
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e) { return; }

    const { type, telegramId, name } = msg;

    // FIX: validate telegramId exists
    if (!telegramId && type !== 'PING') {
      sendTo(ws, { type: 'ERROR', message: 'telegramId обязателен' });
      return;
    }

    if (type === 'PING') {
      sendTo(ws, { type: 'PONG' });
      return;
    }

    if (type === 'JOIN') {
      const id = String(telegramId);
      client.userId = id;
      const user = getUser(id, name);

      sendTo(ws, {
        type: 'JOINED',
        auction: getAuctionState(id),
        user: {
          bids: user.bids,
          totalSpent: user.totalSpent,
          wins: user.wins,
          myAuctionBids: user.myAuctionBids,
          myAuctionSpent: user.myAuctionSpent
        }
      });
      return;
    }

    if (type === 'BID') {
      const id = String(telegramId);

      // FIX: multiple validation checks with clear messages
      if (!auction.active) {
        sendTo(ws, { type: 'ERROR', message: 'Аукцион завершён' });
        return;
      }

      const user = getUser(id, name);

      if (user.bids <= 0) {
        sendTo(ws, { type: 'ERROR', message: 'Нет ставок! Купи пакет в магазине.' });
        return;
      }

      // Anti-consecutive bid protection
      if (auction.leaderId === id) {
        sendTo(ws, { type: 'ERROR', message: 'Ты уже лидер! Подожди ставку другого игрока.' });
        return;
      }

      // Place bid
      user.bids--;
      user.myAuctionBids++;
      user.myAuctionSpent += BID_COST;
      user.totalSpent += BID_COST;

      auction.currentPrice += BID_INCREMENT;
      auction.bidCount++;
      auction.leaderId = id;
      auction.leaderName = user.name;

      // FIX: cap timer correctly — don't exceed maxTime
      auction.timeLeft = Math.min(auction.timeLeft + 10, MAX_TIMER_RESET);

      const bidEntry = {
        userId: id,
        name: user.name,
        price: auction.currentPrice,
        time: new Date().toLocaleTimeString('ru-RU', {
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        })
      };

      auction.bidHistory.push(bidEntry);
      // FIX: keep only last 50 bids
      if (auction.bidHistory.length > 50) auction.bidHistory.shift();

      // Confirm to this bidder first
      sendTo(ws, {
        type: 'BID_CONFIRMED',
        bidsLeft: user.bids,
        currentPrice: auction.currentPrice,
        myAuctionBids: user.myAuctionBids,
        timeLeft: auction.timeLeft
      });

      // Broadcast to everyone
      broadcast({
        type: 'BID_PLACED',
        bid: bidEntry,
        currentPrice: auction.currentPrice,
        bidCount: auction.bidCount,
        leaderName: auction.leaderName,
        leaderId: auction.leaderId,
        timeLeft: auction.timeLeft
      });
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(client);
  });

  // FIX: handle WebSocket errors to prevent server crash
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    clients.delete(client);
  });
});

// ============ REST API ============
app.get('/', (req, res) => {
  res.json({
    status: 'UC Auction running',
    auctionId: auction.id,
    auctionActive: auction.active,
    connectedClients: clients.size,
    totalUsers: Object.keys(users).length
  });
});

app.get('/auction', (req, res) => {
  res.json(getAuctionState());
});

// FIX: validate amount is a positive number
app.post('/add-bids', (req, res) => {
  const { telegramId, name, amount, adminKey } = req.body;

  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Неверный ключ' });
  }

  if (!telegramId) {
    return res.status(400).json({ error: 'telegramId обязателен' });
  }

  const parsedAmount = parseInt(amount);
  if (!parsedAmount || parsedAmount <= 0 || parsedAmount > 1000) {
    return res.status(400).json({ error: 'Неверное количество ставок (1-1000)' });
  }

  const user = getUser(String(telegramId), name);
  user.bids += parsedAmount;

  // Notify if user is connected
  clients.forEach(client => {
    if (client.userId === String(telegramId)) {
      sendTo(client.ws, {
        type: 'BIDS_ADDED',
        amount: parsedAmount,
        totalBids: user.bids,
        message: `✅ Зачислено ${parsedAmount} ставок!`
      });
    }
  });

  res.json({ success: true, telegramId: String(telegramId), bids: user.bids });
});

app.get('/user/:telegramId', (req, res) => {
  const user = users[String(req.params.telegramId)];
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  // FIX: don't expose sensitive fields
  const { id, name, bids, totalSpent, wins, myAuctionBids } = user;
  res.json({ id, name, bids, totalSpent, wins, myAuctionBids });
});

app.get('/admin/users', (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  res.json(Object.values(users));
});

app.get('/discount/:telegramId', (req, res) => {
  const user = users[String(req.params.telegramId)];
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const discount = Math.min(user.myAuctionSpent, MAX_DISCOUNT);
  res.json({
    spent: user.myAuctionSpent,
    discount,
    finalPrice: auction.marketPrice - discount,
    marketPrice: auction.marketPrice
  });
});

// ============ START ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UC Auction server on port ${PORT}`);
  startAuctionTimer();

  // Start admin bot if token is set
  if (process.env.ADMIN_BOT_TOKEN && process.env.ADMIN_CHAT_ID) {
    const adminBot = require('./admin-bot');
    adminBot.poll();
    console.log('Admin bot started');
  }
});
