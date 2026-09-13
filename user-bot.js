const https = require('https');

const USER_BOT_TOKEN = process.env.USER_BOT_TOKEN;
const PAYMENT_CARD = process.env.PAYMENT_CARD || 'Номер карты не задан';
const PAYMENT_NAME = process.env.PAYMENT_NAME || 'UC Auction';

const PACKS = [
  { id: 'p10',  count: 10,  price: 5000,   label: '10 коинов — 5,000 сум' },
  { id: 'p30',  count: 30,  price: 15000,  label: '30 коинов — 15,000 сум ⭐' },
  { id: 'p60',  count: 60,  price: 30000,  label: '60 коинов — 30,000 сум' },
  { id: 'p100', count: 100, price: 50000,  label: '100 коинов — 50,000 сум' },
];

const UC_ITEMS = [
  { id: 'uc60',   uc: 60,   price: 10000,  label: '60 UC — 10,000 сум' },
  { id: 'uc325',  uc: 325,  price: 55000,  label: '325 UC — 55,000 сум' },
  { id: 'uc660',  uc: 660,  price: 96000,  label: '660 UC — 96,000 сум' },
  { id: 'uc1800', uc: 1800, price: 245000, label: '1800 UC — 245,000 сум' },
];

// { telegramId: { step, pack?, uc?, pubgId?, name, prize? } }
const sessions = {};
// Store winner sessions separately - persist even if main session is cleared
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

function sendUser(chatId, text, keyboard) {
  const data = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) data.reply_markup = { inline_keyboard: keyboard };
  return tgRequest('sendMessage', data);
}

function forwardPhoto(fileId, caption) {
  // IMPORTANT: photo file_id belongs to USER bot, must send via USER_BOT_TOKEN
  // Admin must have started the user bot for this to work
  const token = USER_BOT_TOKEN;
  const chatId = process.env.ADMIN_CHAT_ID;

  if (!token || !chatId) {
    console.error('USER_BOT_TOKEN or ADMIN_CHAT_ID not set');
    return Promise.resolve({ ok: false, error: 'missing config' });
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: chatId,
      photo: fileId,
      caption,
      parse_mode: 'HTML'
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendPhoto`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(d);
          if (!result.ok) console.error('forwardPhoto failed:', result.description);
          resolve(result);
        } catch(e) { resolve({ ok: false }); }
      });
    });
    req.on('error', (e) => { console.error('forwardPhoto error:', e.message); resolve({ ok: false }); });
    req.write(body); req.end();
  });
}

async function showMenu(chatId, name) {
  await sendUser(chatId,
    `👋 Привет, <b>${name}</b>!\n\n` +
    `⚡ <b>UC Auction</b> — выигрывай UC по лучшей цене!\n\n` +
    `🪙 <b>Как это работает:</b>\n` +
    `• Купи коины (1 коин = 500 сум)\n` +
    `• Трать коины на ставки в аукционе\n` +
    `• Последний поставивший ставку — победитель!\n` +
    `• Проиграл? Получи скидку 15,000 сум на покупку UC!\n\n` +
    `Выбери:`,
    [
      [{ text: '🪙 Купить коины', callback_data: 'buy_coins' }],
      [{ text: '💎 Купить UC напрямую', callback_data: 'buy_uc' }],
      [{ text: '🎮 Открыть аукцион', url: `https://t.me/${process.env.BOT_USERNAME || 'UCBidbot'}/auction` }],
      [{ text: '❓ Как играть', callback_data: 'howto' }]
    ]
  );
}

async function handleUpdate(update) {
  // Callback
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const userId = String(cb.from.id);
    const name = cb.from.first_name || 'Игрок';
    const data = cb.data;
    await tgRequest('answerCallbackQuery', { callback_query_id: cb.id });

    if (data === 'buy_coins') {
      await sendUser(chatId,
        `🪙 <b>Купить коины</b>\n\n` +
        `1 коин = 500 сум\n` +
        `Чем больше пакет — тем выгоднее!\n\n` +
        `Выбери пакет:`,
        [
          [{ text: '10 коинов — 5,000 сум', callback_data: 'pack_p10' }],
          [{ text: '30 коинов — 15,000 сум ⭐', callback_data: 'pack_p30' }],
          [{ text: '60 коинов — 30,000 сум', callback_data: 'pack_p60' }],
          [{ text: '100 коинов — 50,000 сум', callback_data: 'pack_p100' }],
          [{ text: '⬅️ Назад', callback_data: 'back' }]
        ]
      );
      return;
    }

    if (data.startsWith('pack_')) {
      const pack = PACKS.find(p => p.id === data.replace('pack_', ''));
      if (!pack) return;
      sessions[userId] = { step: 'waiting_coins_screenshot', pack, name };
      await sendUser(chatId,
        `🪙 <b>${pack.label}</b>\n\n` +
        `💳 <b>Реквизиты для оплаты:</b>\n` +
        `Карта: <code>${PAYMENT_CARD}</code>\n` +
        `Получатель: ${PAYMENT_NAME}\n\n` +
        `💰 Сумма: <b>${pack.price.toLocaleString('ru-RU')} сум</b>\n\n` +
        `📸 После оплаты отправь скриншот чека в этот чат.\n` +
        `Коины зачислим в течение нескольких минут.`,
        [[{ text: '❌ Отмена', callback_data: 'cancel' }]]
      );
      return;
    }

    if (data === 'buy_uc') {
      await sendUser(chatId,
        `💎 <b>Прямая покупка UC</b>\n\n` +
        `Выбери количество:`,
        [
          [{ text: '60 UC — 10,000 сум', callback_data: 'uc_uc60' }],
          [{ text: '325 UC — 55,000 сум', callback_data: 'uc_uc325' }],
          [{ text: '660 UC — 96,000 сум', callback_data: 'uc_uc660' }],
          [{ text: '1800 UC — 245,000 сум', callback_data: 'uc_uc1800' }],
          [{ text: '⬅️ Назад', callback_data: 'back' }]
        ]
      );
      return;
    }

    if (data.startsWith('uc_')) {
      const item = UC_ITEMS.find(i => i.id === data.replace('uc_', ''));
      if (!item) return;
      sessions[userId] = { step: 'waiting_pubg_id_uc', uc: item.uc, price: item.price, name };
      await sendUser(chatId,
        `💎 <b>${item.label}</b>\n\n` +
        `Введи свой <b>PUBG ID</b> (числовой ID из игры):`
      );
      return;
    }

    if (data === 'howto') {
      await sendUser(chatId,
        `❓ <b>Как играть?</b>\n\n` +
        `1️⃣ <b>Купи коины</b> — 1 коин = 500 сум\n\n` +
        `2️⃣ <b>Открой аукцион</b> и нажимай ⚡ Ставка\n\n` +
        `3️⃣ <b>Каждая ставка (1 коин):</b>\n` +
        `   • Поднимает цену лота на 100 сум\n` +
        `   • Сбрасывает таймер на 10 сек\n` +
        `   • Делает тебя лидером\n\n` +
        `4️⃣ <b>Кто последний поставил</b> когда таймер истёк — победитель!\n\n` +
        `5️⃣ <b>Проиграл?</b> Получи скидку 15,000 сум на UC!\n\n` +
        `💡 Совет: большие пакеты коинов выгоднее!`,
        [[{ text: '🪙 Купить коины', callback_data: 'buy_coins' }, { text: '⬅️ Назад', callback_data: 'back' }]]
      );
      return;
    }

    if (data === 'cancel') {
      delete sessions[userId];
      await sendUser(chatId, '❌ Отменено.');
      await showMenu(chatId, name);
      return;
    }

    if (data === 'back') {
      await showMenu(chatId, name);
      return;
    }

    return;
  }

  // Text/Photo message
  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const name = msg.from.first_name || 'Игрок';
  const username = msg.from.username || '';
  const text = (msg.text || '').trim();
  const session = sessions[userId];

  if (text === '/start') {
    delete sessions[userId];
    await showMenu(chatId, name);
    return;
  }

  // PUBG ID for UC purchase
  if (session?.step === 'waiting_pubg_id_uc' && text) {
    session.pubgId = text;
    session.step = 'waiting_uc_screenshot';
    await sendUser(chatId,
      `✅ PUBG ID: <code>${text}</code>\n\n` +
      `💳 Реквизиты:\nКарта: <code>${PAYMENT_CARD}</code>\nПолучатель: ${PAYMENT_NAME}\n\n` +
      `💰 Сумма: <b>${session.price.toLocaleString('ru-RU')} сум</b>\n\n` +
      `📸 Теперь отправь скриншот чека об оплате.`,
      [[{ text: '❌ Отмена', callback_data: 'cancel' }]]
    );
    return;
  }

  // PUBG ID from auction winner — check both sessions and winnerSessions
  const winSession = winnerSessions[userId];
  if ((session?.step === 'waiting_winner_pubg_id' || winSession) && text && !text.startsWith('/')) {
    const ws = winSession || session;
    const adminBot = require('./admin-bot');
    adminBot.receivePubgId(userId, text, ws.uc, ws.prize, name);
    delete winnerSessions[userId];
    delete sessions[userId];
    await sendUser(chatId,
      `✅ <b>PUBG ID принят!</b>\n\n` +
      `Ваш ID: <code>${text}</code>\n` +
      `Зачислим <b>${ws.uc} UC</b> в течение нескольких минут.\n\n` +
      `Получите уведомление когда UC будет на счёте!`
    );
    return;
  }

  // Screenshot for coins
  if (msg.photo && session?.step === 'waiting_coins_screenshot') {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const uStr = username ? `@${username}` : 'нет username';
    const caption = `📸 <b>Заявка на коины</b>\n\n👤 ${name} (${uStr})\n🆔 <code>${userId}</code>\n🪙 ${session.pack.count} коинов\n💰 ${session.pack.price.toLocaleString('ru-RU')} сум`;

    const photoResult = await forwardPhoto(fileId, caption);
    console.log('forwardPhoto coins result:', JSON.stringify(photoResult));

    const adminBot = require('./admin-bot');

    // If photo forward failed, send text instead
    if (!photoResult?.ok) {
      await adminBot.notifyAdmin(
        `📸 <b>Новый скриншот оплаты (фото не удалось переслать)</b>\n\n` + caption
      );
    }

    await adminBot.notifyAdmin(
      `👆 Проверь чек и подтверди:`,
      [[
        { text: `✅ Зачислить ${session.pack.count} коинов`, callback_data: `confirm_${userId}_${session.pack.count}` },
        { text: '❌ Отклонить', callback_data: `reject_${userId}` }
      ]]
    );

    adminBot.pendingPayments[userId] = {
      name, packCount: session.pack.count,
      packPrice: session.pack.price, timestamp: Date.now()
    };

    await sendUser(chatId,
      `📤 <b>Скриншот получен!</b>\n\n` +
      `⏳ Проверяем оплату и зачисляем <b>${session.pack.count} коинов</b>.\n` +
      `Обычно занимает до 15 минут.\n\n` +
      `Получишь уведомление когда коины будут зачислены!`
    );
    delete sessions[userId];
    return;
  }

  // Screenshot for UC
  if (msg.photo && session?.step === 'waiting_uc_screenshot') {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const uStr = username ? `@${username}` : 'нет username';
    const caption = `📸 <b>Заявка на UC</b>\n\n👤 ${name} (${uStr})\n🆔 <code>${userId}</code>\n💎 ${session.uc} UC\n🎮 PUBG ID: <code>${session.pubgId}</code>\n💰 ${session.price.toLocaleString('ru-RU')} сум`;

    const photoResult = await forwardPhoto(fileId, caption);
    console.log('forwardPhoto UC result:', JSON.stringify(photoResult));

    const adminBot = require('./admin-bot');
    adminBot.pendingPubgIds[userId] = { pubgId: session.pubgId, uc: session.uc, name, timestamp: Date.now() };

    // If photo forward failed, send text instead
    if (!photoResult?.ok) {
      await adminBot.notifyAdmin(`📸 <b>Скриншот не удалось переслать</b>\n\n` + caption);
    }

    await adminBot.notifyAdmin(
      `👆 Чек выше.\n🎮 PUBG ID: <code>${session.pubgId}</code>\n💎 UC: ${session.uc}`,
      [[
        { text: '✅ UC зачислено', callback_data: `uc_done_${userId}` },
        { text: '❌ Отклонить', callback_data: `uc_reject_${userId}` }
      ]]
    );

    await sendUser(chatId,
      `📤 <b>Скриншот получен!</b>\n\n` +
      `⏳ Проверяем оплату и зачисляем <b>${session.uc} UC</b> на PUBG ID <code>${session.pubgId}</code>.\n` +
      `Обычно занимает до 30 минут.\n\n` +
      `Получишь уведомление когда UC будет на счёте!`
    );
    delete sessions[userId];
    return;
  }

  // Default
  if (!session) {
    await showMenu(chatId, name);
  }
}

// Called when winner confirmed — ask for PUBG ID
function askWinnerPubgId(telegramId, uc, prize) {
  // Store in winnerSessions — persists even if regular session is cleared
  winnerSessions[String(telegramId)] = { step: 'waiting_winner_pubg_id', uc, prize };
  // Also set in regular sessions as backup
  sessions[String(telegramId)] = { step: 'waiting_winner_pubg_id', uc, prize };
}

// Notifications
function notifyUserCoinsAdded(telegramId, amount, total) {
  sendUser(telegramId,
    `✅ <b>Коины зачислены!</b>\n\n` +
    `🪙 +${amount} коинов\n` +
    `💼 Баланс: ${total} коинов\n\n` +
    `Открывай аукцион и побеждай! 🏆`
  );
}

function notifyUserUCDone(telegramId, uc) {
  sendUser(telegramId,
    `✅ <b>${uc} UC зачислено!</b>\n\n` +
    `Проверь баланс в PUBG Mobile. 🎮\n` +
    `Спасибо за покупку!`
  );
}

function notifyUserRejected(telegramId) {
  sendUser(telegramId,
    `❌ <b>Заявка отклонена</b>\n\n` +
    `Возможно, оплата не прошла или скриншот нечёткий.\n` +
    `Попробуй снова или напиши нам.`
  );
}

async function poll() {
  try {
    const res = await tgRequest('getUpdates', {
      offset: lastUpdateId + 1, timeout: 30,
      allowed_updates: ['message', 'callback_query']
    });
    if (res.result?.length) {
      for (const update of res.result) {
        lastUpdateId = update.update_id;
        try { await handleUpdate(update); } catch(e) { console.error('User bot error:', e.message); }
      }
    }
  } catch(e) {
    console.error('User poll error:', e.message);
    await new Promise(r => setTimeout(r, 3000));
  }
  setImmediate(poll);
}

module.exports = { poll, notifyUserCoinsAdded, notifyUserUCDone, notifyUserRejected, askWinnerPubgId, sessions };
