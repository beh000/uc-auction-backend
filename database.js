const { MongoClient } = require('mongodb');

let db = null;
let client = null;

async function connect() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  client = new MongoClient(uri);
  await client.connect();
  db = client.db('ucauction');
  console.log('MongoDB connected');

  // Create indexes
  await db.collection('users').createIndex({ telegramId: 1 }, { unique: true });
  await db.collection('users').createIndex({ referralCode: 1 }, { unique: true, sparse: true });
  await db.collection('auctions').createIndex({ startedAt: -1 });
  await db.collection('promoCodes').createIndex({ code: 1 }, { unique: true });
  await db.collection('votes').createIndex({ telegramId: 1, auctionId: 1 }, { unique: true });
  await db.collection('settings').createIndex({ key: 1 }, { unique: true });

  // Init default settings
  const settings = [
    { key: 'coinCost', value: 500 },
    { key: 'bidIncrement', value: 100 },
    { key: 'minBids', value: 20 },
    { key: 'maxDiscount', value: 15000 },
    { key: 'timerSeconds', value: 30 },
    { key: 'timerAddPerBid', value: 10 },
    { key: 'votesRequired', value: 10 },
    { key: 'auctionStartDelay', value: 300 }, // seconds after votes reached
    { key: 'lots', value: {
      '325':  { uc: 325,  prize: '325 UC',  marketPrice: 55000,  bidCoins: 1 },
      '660':  { uc: 660,  prize: '660 UC',  marketPrice: 96000,  bidCoins: 2 },
      '1800': { uc: 1800, prize: '1800 UC', marketPrice: 245000, bidCoins: 4 }
    }},
    // Prices for buying UC directly (bypassing the auction) — a separate
    // catalog from `lots` above (auction reference prices) on purpose, since
    // direct purchase is intentionally priced higher. Previously hardcoded
    // in three different places (both bots + the frontend shop) with no way
    // for the admin to actually change them.
    { key: 'directPrices', value: {
      uc60:   { uc: 60,   price: 13000  },
      uc325:  { uc: 325,  price: 58000  },
      uc660:  { uc: 660,  price: 115000 },
      uc1800: { uc: 1800, price: 300000 }
    }}
  ];
  for (const s of settings) {
    await db.collection('settings').updateOne(
      { key: s.key },
      { $setOnInsert: s },
      { upsert: true }
    );
  }
  return db;
}

async function getSettings() {
  const d = await connect();
  const docs = await d.collection('settings').find({}).toArray();
  const result = {};
  docs.forEach(doc => result[doc.key] = doc.value);
  return result;
}

async function setSetting(key, value) {
  const d = await connect();
  await d.collection('settings').updateOne({ key }, { $set: { value } }, { upsert: true });
}

// ===== USERS =====
async function getUser(telegramId, name) {
  const d = await connect();
  const id = String(telegramId);
  let user = await d.collection('users').findOne({ telegramId: id });
  if (!user) {
    const referralCode = generateCode(8);
    user = {
      telegramId: id,
      name: name || 'Игрок',
      coins: 0,
      totalSpent: 0,
      ucWon: 0,
      ucPending: 0,
      ucWithdrawn: 0,
      wins: 0,
      totalBids: 0,
      winHistory: [],
      level: 1,
      xp: 0,
      referralCode,
      referredBy: null,
      referrals: 0,
      myAuctionCoins: 0,
      myAuctionSpent: 0,
      createdAt: new Date()
    };
    await d.collection('users').insertOne(user);
  }
  if (name && user.name !== name) {
    await d.collection('users').updateOne({ telegramId: id }, { $set: { name } });
    user.name = name;
  }
  return user;
}

// Unlike getUser(), never creates a record — for admin operations that must
// tell a real player apart from a typo'd/nonexistent telegramId.
async function findUser(telegramId) {
  const d = await connect();
  return d.collection('users').findOne({ telegramId: String(telegramId) });
}

async function updateUser(telegramId, update) {
  const d = await connect();
  await d.collection('users').updateOne({ telegramId: String(telegramId) }, { $set: update });
}

async function incrementUser(telegramId, inc) {
  const d = await connect();
  await d.collection('users').updateOne({ telegramId: String(telegramId) }, { $inc: inc });
}

// Atomically deduct coins for a bid; returns null if the user doesn't have enough
// (prevents the read-then-write race that let concurrent bids overdraw a balance).
async function placeBid(telegramId, cost, spend) {
  const d = await connect();
  const id = String(telegramId);
  const result = await d.collection('users').findOneAndUpdate(
    { telegramId: id, coins: { $gte: cost } },
    { $inc: { coins: -cost, myAuctionCoins: cost, myAuctionSpent: spend, totalSpent: spend, totalBids: 1 } },
    { returnDocument: 'after' }
  );
  return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
}

// Zero out the "coins spent in the current auction" counter for everyone when a
// new auction launches, so the post-auction consolation discount only reflects
// participation in that auction (it was never reset before).
async function resetMyAuctionCoins() {
  const d = await connect();
  await d.collection('users').updateMany(
    { myAuctionCoins: { $ne: 0 } },
    { $set: { myAuctionCoins: 0, myAuctionSpent: 0 } }
  );
}

async function getUserByReferral(code) {
  const d = await connect();
  return d.collection('users').findOne({ referralCode: code });
}

async function getLeaderboard() {
  const d = await connect();
  return d.collection('users')
    .find({ ucWon: { $gt: 0 } })
    .sort({ ucWon: -1 })
    .limit(20)
    .toArray();
}

async function getAllUsers() {
  const d = await connect();
  return d.collection('users')
    .find({}, { projection: { telegramId: 1, name: 1, coins: 1, wins: 1, ucWon: 1, ucPending: 1, totalSpent: 1, level: 1 } })
    .sort({ totalSpent: -1 })
    .limit(100)
    .toArray();
}

// ===== AUCTIONS =====
async function saveAuction(auctionData) {
  const d = await connect();
  await d.collection('auctions').insertOne({ ...auctionData, savedAt: new Date() });
}

async function getAuctionHistory(limit = 20) {
  const d = await connect();
  return d.collection('auctions')
    .find({})
    .sort({ startedAt: -1 })
    .limit(limit)
    .toArray();
}

// ===== PROMO CODES =====
async function createPromo(code, coins, maxUses) {
  const d = await connect();
  await d.collection('promoCodes').insertOne({
    code: code.toUpperCase(),
    coins,
    maxUses,
    usedCount: 0,
    usedBy: [],
    active: true,
    createdAt: new Date()
  });
}

async function usePromo(code, telegramId) {
  const d = await connect();
  const promo = await d.collection('promoCodes').findOne({ code: code.toUpperCase(), active: true });
  if (!promo) return { ok: false, error: 'Промокод не найден или истёк' };
  if (promo.usedBy.includes(String(telegramId))) return { ok: false, error: 'Ты уже использовал этот промокод' };
  if (promo.usedCount >= promo.maxUses) return { ok: false, error: 'Промокод уже использован максимальное количество раз' };

  await d.collection('promoCodes').updateOne(
    { code: code.toUpperCase() },
    { $inc: { usedCount: 1 }, $push: { usedBy: String(telegramId) } }
  );
  if (promo.usedCount + 1 >= promo.maxUses) {
    await d.collection('promoCodes').updateOne({ code: code.toUpperCase() }, { $set: { active: false } });
  }
  return { ok: true, coins: promo.coins };
}

async function listPromos() {
  const d = await connect();
  return d.collection('promoCodes').find({}).sort({ createdAt: -1 }).limit(20).toArray();
}

async function deletePromo(code) {
  const d = await connect();
  await d.collection('promoCodes').deleteOne({ code: code.toUpperCase() });
}

// ===== VOTES =====
async function addVote(telegramId, lotKey, auctionId) {
  const d = await connect();
  try {
    await d.collection('votes').insertOne({
      telegramId: String(telegramId),
      lotKey,
      auctionId,
      createdAt: new Date()
    });
    return true;
  } catch(e) {
    return false; // duplicate vote
  }
}

async function getVotes(auctionId) {
  const d = await connect();
  const votes = await d.collection('votes').find({ auctionId }).toArray();
  const result = {};
  votes.forEach(v => { result[v.lotKey] = (result[v.lotKey] || 0) + 1; });
  return result;
}

async function clearVotes(auctionId) {
  const d = await connect();
  await d.collection('votes').deleteMany({ auctionId });
}

// ===== HELPERS =====
function generateCode(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function calculateLevel(wins, totalBids) {
  const xp = wins * 100 + Math.floor(totalBids / 10) * 5;
  if (xp >= 2000) return { level: 4, title: '👑 Легенда', xp, nextXp: null };
  if (xp >= 500)  return { level: 3, title: '⚔️ Ветеран',  xp, nextXp: 2000 };
  if (xp >= 100)  return { level: 2, title: '🎯 Охотник',  xp, nextXp: 500 };
  return { level: 1, title: '🌱 Новичок', xp, nextXp: 100 };
}

module.exports = {
  connect, getSettings, setSetting,
  getUser, findUser, updateUser, incrementUser, placeBid, resetMyAuctionCoins,
  getUserByReferral, getLeaderboard, getAllUsers,
  saveAuction, getAuctionHistory,
  createPromo, usePromo, listPromos, deletePromo,
  addVote, getVotes, clearVotes,
  generateCode, calculateLevel
};
