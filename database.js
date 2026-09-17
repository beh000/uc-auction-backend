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

  // Create indexes — best-effort. A transient issue here (e.g. low disk
  // headroom, which index builds are more sensitive to than plain writes)
  // must not skip the settings seeding below: it previously did, silently
  // leaving `lots`/`directPrices` unset in the DB and every admin lot/price
  // menu empty, even though the auction itself kept working off in-code
  // fallback defaults.
  try {
    await db.collection('users').createIndex({ telegramId: 1 }, { unique: true });
    await db.collection('users').createIndex({ referralCode: 1 }, { unique: true, sparse: true });
    await db.collection('auctions').createIndex({ startedAt: -1 });
    await db.collection('promoCodes').createIndex({ code: 1 }, { unique: true });
    await db.collection('votes').createIndex({ telegramId: 1, auctionId: 1 }, { unique: true });
    await db.collection('settings').createIndex({ key: 1 }, { unique: true });
  } catch (e) {
    console.error('Index creation failed, continuing without them:', e.message);
  }

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
    try {
      await db.collection('settings').updateOne(
        { key: s.key },
        { $setOnInsert: s },
        { upsert: true }
      );
    } catch (e) {
      console.error(`Failed to seed setting "${s.key}":`, e.message);
    }
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

// Callers pass either plain fields (wrapped in $set) or a mix that also
// includes raw operators like $push/$inc — nesting those inside $set's
// document is rejected by MongoDB ("$ prefixed field ... not allowed"),
// which previously made endAuction() throw before announcing the winner.
async function updateUser(telegramId, update) {
  const d = await connect();
  const { $push, $inc, $unset, ...fields } = update;
  const ops = {};
  if (Object.keys(fields).length) ops.$set = fields;
  if ($push) ops.$push = $push;
  if ($inc) ops.$inc = $inc;
  if ($unset) ops.$unset = $unset;
  await d.collection('users').updateOne({ telegramId: String(telegramId) }, ops);
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

// Atomic claim, same reasoning as usePromo above: two /start ref_x hits
// (e.g. opened on two devices) could otherwise both read referredBy as unset
// and both write, paying the referral bonus twice for one signup.
async function claimReferral(telegramId, referralCode) {
  const d = await connect();
  const result = await d.collection('users').findOneAndUpdate(
    { telegramId: String(telegramId), referredBy: null },
    { $set: { referredBy: referralCode } },
    { returnDocument: 'after' }
  );
  return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
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

// Atomic check-and-claim: the old version read the promo, checked usedBy/
// usedCount in JS, then wrote — two requests for the same code arriving close
// together (a double-tap, or a deliberate script once real coins are on the
// line) could both pass the check before either write landed, and both would
// get paid. Folding the same conditions into the update's filter makes only
// one concurrent claim possible; the loser gets a normal "already used" error.
async function usePromo(code, telegramId) {
  const d = await connect();
  const upperCode = code.toUpperCase();
  const id = String(telegramId);
  const claimed = await d.collection('promoCodes').findOneAndUpdate(
    {
      code: upperCode,
      active: true,
      usedBy: { $ne: id },
      $expr: { $lt: ['$usedCount', '$maxUses'] }
    },
    { $inc: { usedCount: 1 }, $push: { usedBy: id } },
    { returnDocument: 'after' }
  );
  const promo = claimed && Object.prototype.hasOwnProperty.call(claimed, 'value') ? claimed.value : claimed;
  if (!promo) {
    const existing = await d.collection('promoCodes').findOne({ code: upperCode });
    if (!existing || !existing.active) return { ok: false, error: 'Промокод не найден или истёк' };
    if (existing.usedBy.includes(id)) return { ok: false, error: 'Ты уже использовал этот промокод' };
    return { ok: false, error: 'Промокод уже использован максимальное количество раз' };
  }
  if (promo.usedCount >= promo.maxUses) {
    await d.collection('promoCodes').updateOne({ code: upperCode }, { $set: { active: false } });
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
  getUserByReferral, claimReferral, getLeaderboard, getAllUsers,
  saveAuction, getAuctionHistory,
  createPromo, usePromo, listPromos, deletePromo,
  addVote, getVotes, clearVotes,
  generateCode, calculateLevel
};
