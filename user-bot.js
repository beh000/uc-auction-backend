const https = require('https');
const http = require('http');
const db = require('./database');

const USER_BOT_TOKEN = process.env.USER_BOT_TOKEN;
const PAYMENT_CARD = process.env.PAYMENT_CARD || 'Номер не задан';
const PAYMENT_NAME = process.env.PAYMENT_NAME || 'UC Auction';
const BOT_USERNAME = process.env.BOT_USERNAME || 'UCBidbot';

// Pack sizes are fixed; the price per coin always tracks the live coinCost
// setting instead of being baked in, so a /set coinCost change is reflected
// immediately instead of silently going stale.
const PACK_SIZES = [10, 30, 60, 100];

// Fallback only — used if the backend's own /prices call fails, so the bot
// still works. The real, currently-configured prices always come from there,
// since these used to be the only prices anywhere and admin edits never
// reached them.
const FALLBACK_UC_ITEMS = [
  { id: 'uc60',   uc: 60,   price: 13000  },
  { id: 'uc325',  uc: 325,  price: 58000  },
  { id: 'uc660',  uc: 660,  price: 115000 },
  { id: 'uc1800', uc: 1800, price: 300000 },
];

function getJson(path) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: process.env.PORT || 3000,
      path, method: 'GET'
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Always reflects whatever the admin last set via /setlot and /setprice —
// never hardcoded, so prices shown here can't drift from the real config.
async function getPrices() {
  const prices = await getJson('/prices');
  const direct = prices?.direct
    ? Object.entries(prices.direct).map(([id, item]) => ({ id, uc: item.uc, price: item.price }))
    : FALLBACK_UC_ITEMS;
  const lots = prices?.lots || {};
  const maxDiscount = prices?.maxDiscount || 15000;
  const coinCost = prices?.coinCost || 500;
  const packs = PACK_SIZES.map(count => ({ id: 'p' + count, count, price: count * coinCost }));
  return { direct, lots, maxDiscount, coinCost, packs };
}

const sessions = {};
const winnerSessions = {};
let lastUpdateId = 0;

function tgRequest(method, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${USER_BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(body); req.end();
  });
}

function send(chatId, text, keyboard) {
  const data = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) data.reply_markup = { inline_keyboard: keyboard };
  return tgRequest('sendMessage', data);
}

function sendPhoto(chatId, fileId, caption) {
  return tgRequest('sendPhoto', { chat_id: chatId, photo: fileId, caption, parse_mode: 'HTML' });
}

async function showMenu(chatId, name) {
  let user;
  try { user = await db.getUser(String(chatId), name); } catch(e) { user = null; }
  const levelInfo = user ? db.calculateLevel(user.wins || 0, user.totalBids || 0) : null;

  await send(chatId,
    `👋 Привет, <b>${name}</b>! ${levelInfo ? levelInfo.title : ''}\n\n` +
    `⚡ <b>UC Auction</b> — выигрывай UC по лучшей цене!\n\n` +
    `🪙 Твой баланс: <b>${user ? user.coins : 0} коинов</b>\n\n` +
    `Выбери:`,
    [
      [{ text: '🪙 Купить коины', callback_data: 'buy_coins' }],
      [{ text: '💎 Купить UC напрямую', callback_data: 'buy_uc' }],
      [{ text: '🎮 Открыть аукцион', url: `https://t.me/${BOT_USERNAME}/auction` }],
      [{ text: '🎟 Промокод', callback_data: 'promo' }, { text: '👥 Реферал', callback_data: 'referral' }],
      [{ text: '❓ Как играть', callback_data: 'howto' }]
    ]
  );
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const userId = String(cb.from.id);
    const name = cb.from.first_name || 'Игрок';
    const data = cb.data;
    await tgRequest('answerCallbackQuery', { callback_query_id: cb.id });

    if (data === 'buy_coins') {
      const { packs, coinCost } = await getPrices();
      const buttons = packs.map((p, i) => ([{
        text: `${p.count} коинов — ${p.price.toLocaleString('ru-RU')} сум${i === 1 ? ' ⭐' : ''}`,
        callback_data: `pack_${p.id}`
      }]));
      buttons.push([{ text: '⬅️ Назад', callback_data: 'back' }]);
      await send(chatId, `🪙 <b>Купить коины</b>\n\n1 коин = ${coinCost} сум\nВыбери пакет:`, buttons);
      return;
    }

    if (data.startsWith('pack_')) {
      const { packs } = await getPrices();
      const pack = packs.find(p => p.id === data.replace('pack_', ''));
      if (!pack) return;
      sessions[userId] = { step: 'waiting_coins_screenshot', pack, name };
      // Send payment details immediately
      await send(chatId,
        `🪙 <b>${pack.count} коинов — ${pack.price.toLocaleString('ru-RU')} сум</b>\n\n` +
        `💳 <b>Реквизиты для оплаты:</b>\n` +
        `Карта: <code>${PAYMENT_CARD}</code>\n` +
        `Получатель: ${PAYMENT_NAME}\n\n` +
        `💰 Сумма к переводу: <b>${pack.price.toLocaleString('ru-RU')} сум</b>\n\n` +
        `📸 После перевода отправь скриншот чека прямо сюда.\n` +
        `⏱ Коины зачислим в течение 5-15 минут.`,
        [[{ text: '❌ Отмена', callback_data: 'cancel' }]]
      );
      return;
    }

    if (data === 'buy_uc') {
      const { direct } = await getPrices();
      const buttons = direct.map(item => ([{
        text: `${item.uc} UC — ${item.price.toLocaleString('ru-RU')} сум`,
        callback_data: `uc_${item.id}`
      }]));
      buttons.push([{ text: '⬅️ Назад', callback_data: 'back' }]);
      await send(chatId, `💎 <b>Прямая покупка UC</b>\n\nВыбери количество:`, buttons);
      return;
    }

    if (data.startsWith('uc_')) {
      const { direct } = await getPrices();
      const item = direct.find(i => i.id === data.replace('uc_', ''));
      if (!item) return;
      sessions[userId] = { step: 'waiting_pubg_id_uc', uc: item.uc, price: item.price, name };
      await send(chatId, `💎 <b>${item.uc} UC — ${item.price.toLocaleString('ru-RU')} сум</b>\n\nВведи свой <b>PUBG ID</b>:`);
      return;
    }

    // Consolation-discount purchase — price is the lot's market price minus
    // maxDiscount, actually applied here (the old flow only showed the
    // discounted number in the button text but then charged full price).
    if (data.startsWith('discount_')) {
      const lotKey = data.replace('discount_', '');
      const { lots, maxDiscount } = await getPrices();
      const lot = lots[lotKey];
      if (!lot) return;
      const price = Math.max(0, (lot.marketPrice || 0) - maxDiscount);
      sessions[userId] = { step: 'waiting_pubg_id_uc', uc: lot.uc, price, name };
      await send(chatId, `🎁 <b>${lot.uc} UC — ${price.toLocaleString('ru-RU')} сум (со скидкой)</b>\n\nВведи свой <b>PUBG ID</b>:`);
      return;
    }

    if (data === 'promo') {
      sessions[userId] = { step: 'waiting_promo', name };
      await send(chatId, `🎟 Введи промокод:`, [[{ text: '❌ Отмена', callback_data: 'cancel' }]]);
      return;
    }

    if (data === 'referral') {
      try {
        const user = await db.getUser(userId, name);
        const link = `https://t.me/${BOT_USERNAME}?start=ref_${user.referralCode}`;
        await send(chatId,
          `👥 <b>Реферальная программа</b>\n\n` +
          `Приглашай друзей и получай <b>5 коинов</b> за каждого!\n` +
          `Друг тоже получит 5 коинов при регистрации.\n\n` +
          `🔗 Твоя ссылка:\n${link}\n\n` +
          `👤 Приглашено: ${user.referrals || 0} чел.`,
          [[{ text: '⬅️ Назад', callback_data: 'back' }]]
        );
      } catch(e) { await send(chatId, '❌ Ошибка'); }
      return;
    }

    if (data === 'howto') {
      await send(chatId,
        `❓ <b>Как играть?</b>\n\n` +
        `1️⃣ Купи коины (1 коин = 500 сум)\n\n` +
        `2️⃣ Проголосуй за лот в аукционе\n\n` +
        `3️⃣ Когда наберётся нужно голосов — аукцион стартует!\n\n` +
        `4️⃣ Каждая ставка (1 коин):\n   • Поднимает цену на 100 сум\n   • Сбрасывает таймер\n\n` +
        `5️⃣ Последний поставивший — победитель!\n\n` +
        `🎁 Проиграл? Скидка 15,000 сум на UC!`,
        [[{ text: '🪙 Купить коины', callback_data: 'buy_coins' }, { text: '⬅️ Назад', callback_data: 'back' }]]
      );
      return;
    }

    if (data === 'cancel') { delete sessions[userId]; await showMenu(chatId, name); return; }
    if (data === 'back') { await showMenu(chatId, name); return; }
    return;
  }

  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const name = msg.from.first_name || 'Игрок';
  const username = msg.from.username || '';
  const text = (msg.text || '').trim();
  const session = sessions[userId];
  const winSession = winnerSessions[userId];

  // Handle /start with referral
  if (text.startsWith('/start')) {
    delete sessions[userId];
    const param = text.split(' ')[1];

    if (param && param.startsWith('ref_')) {
      const refCode = param.replace('ref_', '');
      try {
        const user = await db.getUser(userId, name);
        if (!user.referredBy && refCode !== user.referralCode) {
          const http = require('http');
          const body = JSON.stringify({ telegramId: userId, referralCode: refCode });
          const req = http.request({
            hostname: '127.0.0.1', port: process.env.PORT || 3000,
            path: '/use-referral', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Internal-Key': process.env.ADMIN_KEY || '' }
          }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', async () => {
              try {
                const result = JSON.parse(d);
                if (result.success) {
                  await send(chatId, `🎉 Реферальный бонус: +${result.bonus} коинов зачислено!`);
                }
              } catch(e) {}
            });
          });
          req.on('error', () => {});
          req.write(body); req.end();
        }
      } catch(e) {}
    }

    if (param === 'discount') {
      const { lots, maxDiscount } = await getPrices();
      const buttons = Object.entries(lots).map(([key, lot]) => ([{
        text: `${lot.prize} — ${Math.max(0, (lot.marketPrice||0) - maxDiscount).toLocaleString('ru-RU')} сум`,
        callback_data: `discount_${key}`
      }]));
      await send(chatId,
        `🎁 <b>Скидка ${maxDiscount.toLocaleString('ru-RU')} сум на UC!</b>\n\n` +
        `Выбери UC со скидкой:`,
        buttons
      );
      return;
    }

    await showMenu(chatId, name);
    return;
  }

  // Promo code input
  if (session?.step === 'waiting_promo' && text && !text.startsWith('/')) {
    try {
      const http = require('http');
      const body = JSON.stringify({ code: text.toUpperCase(), telegramId: userId });
      const req = http.request({
        hostname: '127.0.0.1', port: process.env.PORT || 3000,
        path: '/use-promo', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Internal-Key': process.env.ADMIN_KEY || '' }
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', async () => {
          try {
            const result = JSON.parse(d);
            delete sessions[userId];
            if (result.success) {
              await send(chatId, `✅ Промокод активирован!\n🪙 +${result.coins} коинов зачислено!`);
            } else {
              await send(chatId, `❌ ${result.error || 'Неверный промокод'}`);
            }
          } catch(e) { await send(chatId, '❌ Ошибка'); }
        });
      });
      req.on('error', async () => await send(chatId, '❌ Ошибка сервера'));
      req.write(body); req.end();
    } catch(e) { await send(chatId, '❌ Ошибка'); }
    return;
  }

  // PUBG ID for winner
  if ((winSession || session?.step === 'waiting_winner_pubg_id') && text && !text.startsWith('/')) {
    const ws = winSession || session;
    try { require('./admin-bot').receivePubgId(userId, text, ws.uc, ws.prize, name); } catch(e) {}
    delete winnerSessions[userId];
    delete sessions[userId];
    await send(chatId,
      `✅ <b>PUBG ID принят!</b>\n\nВаш ID: <code>${text}</code>\n` +
      `Зачислим <b>${ws.uc} UC</b> в течение нескольких минут.`
    );
    return;
  }

  // PUBG ID for direct UC purchase
  if (session?.step === 'waiting_pubg_id_uc' && text && !text.startsWith('/')) {
    session.pubgId = text;
    session.step = 'waiting_uc_screenshot';
    await send(chatId,
      `✅ PUBG ID: <code>${text}</code>\n\n` +
      `💳 Реквизиты:\n<code>${PAYMENT_CARD}</code>\n${PAYMENT_NAME}\n\n` +
      `💰 Сумма: <b>${session.price.toLocaleString('ru-RU')} сум</b>\n\n` +
      `📸 Отправь скриншот чека.`,
      [[{ text: '❌ Отмена', callback_data: 'cancel' }]]
    );
    return;
  }

  // Screenshot for coins
  if (msg.photo && session?.step === 'waiting_coins_screenshot') {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const uStr = username ? `@${username}` : 'нет username';
    const caption = `📸 <b>Заявка на коины</b>\n\n👤 ${name} (${uStr})\n🆔 <code>${userId}</code>\n🪙 ${session.pack.count} коинов\n💰 ${session.pack.price.toLocaleString('ru-RU')} сум`;

    const photoResult = await sendPhoto(process.env.ADMIN_CHAT_ID, fileId, caption);
    console.log('Photo to admin:', photoResult?.ok);

    try {
      const adminBot = require('./admin-bot');
      if (!photoResult?.ok) await adminBot.notifyAdmin(`📸 Не удалось переслать фото\n\n` + caption);
      await adminBot.notifyAdmin(`👆 Чек выше. Подтвердить?`, [[
        { text: `✅ Зачислить ${session.pack.count} коинов`, callback_data: `confirm_${userId}_${session.pack.count}` },
        { text: '❌ Отклонить', callback_data: `reject_${userId}` }
      ]]);
      adminBot.pendingPayments[userId] = { name, packCount: session.pack.count, packPrice: session.pack.price, timestamp: Date.now() };
    } catch(e) { console.error('Admin notify error:', e.message); }

    await send(chatId, `📤 Скриншот получен!\n⏳ Зачислим <b>${session.pack.count} коинов</b> в течение 15 минут.`);
    delete sessions[userId];
    return;
  }

  // Screenshot for UC
  if (msg.photo && session?.step === 'waiting_uc_screenshot') {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const uStr = username ? `@${username}` : 'нет username';
    const caption = `📸 <b>Заявка на UC</b>\n\n👤 ${name} (${uStr})\n🆔 <code>${userId}</code>\n💎 ${session.uc} UC\n🎮 PUBG ID: <code>${session.pubgId}</code>\n💰 ${session.price.toLocaleString('ru-RU')} сум`;

    const photoResult = await sendPhoto(process.env.ADMIN_CHAT_ID, fileId, caption);
    console.log('UC Photo to admin:', photoResult?.ok);

    try {
      const adminBot = require('./admin-bot');
      if (!photoResult?.ok) await adminBot.notifyAdmin(`📸 Не удалось переслать фото\n\n` + caption);
      adminBot.pendingPubgIds[userId] = { pubgId: session.pubgId, uc: session.uc, name, timestamp: Date.now() };
      await adminBot.notifyAdmin(`👆 Чек выше.\n🎮 PUBG ID: <code>${session.pubgId}</code>\n💎 UC: ${session.uc}`, [[
        { text: '✅ UC зачислено', callback_data: `uc_done_${userId}` },
        { text: '❌ Отклонить', callback_data: `uc_reject_${userId}` }
      ]]);
    } catch(e) { console.error('Admin notify error:', e.message); }

    await send(chatId, `📤 Скриншот получен!\n⏳ Зачислим <b>${session.uc} UC</b> на PUBG ID <code>${session.pubgId}</code> в течение 30 минут.`);
    delete sessions[userId];
    return;
  }

  if (!session && !winSession) await showMenu(chatId, name);
}

function askWinnerPubgId(telegramId, uc, prize) {
  winnerSessions[String(telegramId)] = { step: 'waiting_winner_pubg_id', uc, prize };
  sessions[String(telegramId)] = { step: 'waiting_winner_pubg_id', uc, prize };
}

function notifyUserCoinsAdded(telegramId, amount, total) {
  send(telegramId, `✅ <b>+${amount} коинов зачислено!</b>\n💼 Баланс: ${total} 🪙\n\nОткрывай аукцион и побеждай! 🏆`);
}

function notifyUserUCDone(telegramId, uc) {
  send(telegramId, `✅ <b>${uc} UC зачислено!</b>\n\nПроверь баланс в PUBG Mobile. 🎮`);
}

function notifyUserRejected(telegramId) {
  send(telegramId, `❌ <b>Заявка отклонена</b>\n\nВозможно оплата не прошла. Попробуй снова.`);
}

async function poll() {
  let healthy = true;
  try {
    const res = await tgRequest('getUpdates', {
      offset: lastUpdateId + 1, timeout: 30,
      allowed_updates: ['message', 'callback_query']
    });
    if (res.ok === false) {
      console.error('User poll error:', res.description || 'unknown');
      healthy = false;
    } else if (res.result?.length) {
      for (const update of res.result) {
        lastUpdateId = update.update_id;
        try { await handleUpdate(update); } catch(e) { console.error('User bot error:', e.message); }
      }
    }
  } catch(e) {
    console.error('User poll error:', e.message);
    healthy = false;
  }
  if (healthy) setImmediate(poll);
  else setTimeout(poll, 3000);
}

module.exports = { poll, askWinnerPubgId, notifyUserCoinsAdded, notifyUserUCDone, notifyUserRejected, sessions, winnerSessions };
