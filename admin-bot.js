const https = require('https');
const http = require('http');

const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BACKEND_URL = 'http://localhost:' + (process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY;

const pendingPayments = {};
const pendingPubgIds = {}; // { telegramId: { uc, prize, pubgId } }
let lastUpdateId = 0;

function tgRequest(method, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${ADMIN_BOT_TOKEN}/${method}`,
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

function sendMessage(chatId, text, keyboard) {
  const data = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) data.reply_markup = { inline_keyboard: keyboard };
  return tgRequest('sendMessage', data);
}

function answerCallback(id, text) {
  return tgRequest('answerCallbackQuery', { callback_query_id: id, text });
}

function localRequest(path, method, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const url = new URL(BACKEND_URL + path);
    const options = {
      hostname: url.hostname, port: url.port || 80,
      path: url.pathname + (url.search || ''), method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = http.request(options, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', () => resolve({ error: 'Ошибка сервера' }));
    if (data) req.write(data); req.end();
  });
}

async function handleUpdate(update) {
  // Callback
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    if (String(chatId) !== String(ADMIN_CHAT_ID)) { await answerCallback(cb.id, '❌ Нет доступа'); return; }
    const data = cb.data;

    // Confirm coins
    if (data.startsWith('confirm_')) {
      const parts = data.replace('confirm_', '').split('_');
      const telegramId = parts[0];
      const count = parseInt(parts[1]);
      const payment = pendingPayments[telegramId];
      const amount = count || payment?.packCount;
      if (!amount) { await answerCallback(cb.id, '❌ Заявка не найдена'); return; }

      const result = await localRequest('/add-coins', 'POST', {
        telegramId, name: payment?.name || 'Игрок', amount, adminKey: ADMIN_KEY
      });

      if (result.success) {
        delete pendingPayments[telegramId];
        await answerCallback(cb.id, '✅ Зачислено!');
        await sendMessage(chatId,
          `✅ <b>${amount} коинов зачислено</b>\n` +
          `Игрок: ${payment?.name || telegramId} (<code>${telegramId}</code>)\n` +
          `Баланс: ${result.coins} коинов`
        );
        if (process.env.USER_BOT_TOKEN) {
          const ub = require('./user-bot');
          ub.notifyUserCoinsAdded(telegramId, amount, result.coins);
        }
      } else {
        await answerCallback(cb.id, '❌ ' + (result.error || 'Ошибка'));
      }
      return;
    }

    // Reject coins
    if (data.startsWith('reject_')) {
      const telegramId = data.replace('reject_', '');
      const payment = pendingPayments[telegramId];
      delete pendingPayments[telegramId];
      await answerCallback(cb.id, '❌ Отклонено');
      await sendMessage(chatId, `❌ Заявка от ${payment?.name || telegramId} отклонена`);
      if (process.env.USER_BOT_TOKEN) {
        const ub = require('./user-bot');
        ub.notifyUserRejected(telegramId);
      }
      return;
    }

    // UC delivered (mark as withdrawn)
    if (data.startsWith('uc_done_')) {
      const telegramId = data.replace('uc_done_', '');
      const pending = pendingPubgIds[telegramId];
      if (!pending) { await answerCallback(cb.id, '❌ Данные не найдены'); return; }

      const result = await localRequest('/mark-withdrawn', 'POST', {
        telegramId, uc: pending.uc, adminKey: ADMIN_KEY
      });

      if (result.success) {
        await answerCallback(cb.id, '✅ Отмечено как выдано!');
        await sendMessage(chatId,
          `✅ <b>${pending.uc} UC выдано</b>\n` +
          `Игрок: <code>${telegramId}</code>\n` +
          `PUBG ID: <code>${pending.pubgId}</code>`
        );
        delete pendingPubgIds[telegramId];
        if (process.env.USER_BOT_TOKEN) {
          const ub = require('./user-bot');
          ub.notifyUserUCDone(telegramId, pending.uc);
        }
      } else {
        await answerCallback(cb.id, '❌ ' + (result.error || 'Ошибка'));
      }
      return;
    }

    // UC reject
    if (data.startsWith('uc_reject_')) {
      const telegramId = data.replace('uc_reject_', '');
      delete pendingPubgIds[telegramId];
      await answerCallback(cb.id, '❌ Отклонено');
      await sendMessage(chatId, `❌ Заявка на UC от <code>${telegramId}</code> отклонена`);
      if (process.env.USER_BOT_TOKEN) {
        const ub = require('./user-bot');
        ub.notifyUserRejected(telegramId);
      }
      return;
    }

    // Stats
    if (data === 'stats') {
      const result = await localRequest('/');
      await answerCallback(cb.id, '📊');
      await sendMessage(chatId,
        `📊 <b>Статистика</b>\n\n` +
        `🎮 Аукцион: ${result.auctionActive ? `🟢 ${result.auctionLot}` : '🔴 Нет'}\n` +
        `👥 Игроков: ${result.users || 0}\n` +
        `🔌 Онлайн: ${result.clients || 0}`,
        [[
          { text: '🚀 Запустить аукцион', callback_data: 'start_auction' },
          { text: '🔄 Обновить', callback_data: 'stats' }
        ]]
      );
      return;
    }

    // Start auction — lot selection
    if (data === 'start_auction') {
      const result = await localRequest('/');
      if (result.auctionActive) { await answerCallback(cb.id, '⚠️ Аукцион уже идёт!'); return; }
      await answerCallback(cb.id, 'Выбери лот');
      await sendMessage(chatId, `🎮 <b>Выбери лот:</b>`, [
        [{ text: '💙 325 UC — 55,000 сум', callback_data: 'launch_325' }],
        [{ text: '💎 660 UC — 96,000 сум', callback_data: 'launch_660' }],
        [{ text: '👑 1800 UC — 245,000 сум', callback_data: 'launch_1800' }]
      ]);
      return;
    }

    // Launch lot
    if (data.startsWith('launch_')) {
      const lotKey = data.replace('launch_', '');
      const result = await localRequest('/start-auction', 'POST', { lotKey, adminKey: ADMIN_KEY });
      if (result.success) {
        await answerCallback(cb.id, '🚀 Запущен!');
        await sendMessage(chatId, `🚀 <b>Аукцион запущен!</b>\nЛот: ${result.auction?.prize || lotKey + ' UC'}`);
      } else {
        await answerCallback(cb.id, '❌ ' + (result.error || 'Ошибка'));
      }
      return;
    }

    return;
  }

  // Text message
  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const isAdmin = String(chatId) === String(ADMIN_CHAT_ID);
  const text = (msg.text || '').trim();

  if (!isAdmin) { await sendMessage(chatId, '❌ Только для администратора.'); return; }

  if (text === '/start') {
    await sendMessage(chatId,
      `👋 <b>UC Auction Admin</b>\n\n` +
      `Команды:\n` +
      `/stats — статистика\n` +
      `/users — список игроков\n` +
      `/add [id] [кол-во] — зачислить коины\n` +
      `/stop — остановить аукцион`,
      [[
        { text: '🚀 Запустить аукцион', callback_data: 'start_auction' },
        { text: '📊 Статистика', callback_data: 'stats' }
      ]]
    );
    return;
  }

  if (text === '/stats') {
    const r = await localRequest('/');
    await sendMessage(chatId,
      `📊 <b>Статистика</b>\n\n` +
      `🎮 Аукцион: ${r.auctionActive ? `🟢 ${r.auctionLot}` : '🔴 Нет'}\n` +
      `👥 Игроков: ${r.users || 0} | 🔌 Онлайн: ${r.clients || 0}`,
      [[{ text: '🚀 Запустить аукцион', callback_data: 'start_auction' }, { text: '🔄 Обновить', callback_data: 'stats' }]]
    );
    return;
  }

  if (text === '/stop') {
    const r = await localRequest('/stop-auction', 'POST', { adminKey: ADMIN_KEY });
    await sendMessage(chatId, r.success ? '✅ Аукцион остановлен' : '❌ ' + (r.error || 'Ошибка'));
    return;
  }

  if (text.startsWith('/add')) {
    const parts = text.split(' ');
    if (parts.length < 3) { await sendMessage(chatId, '❌ Формат: /add [telegramId] [количество коинов]'); return; }
    const amount = parseInt(parts[2]);
    if (!amount || amount <= 0) { await sendMessage(chatId, '❌ Неверное количество'); return; }
    const r = await localRequest('/add-coins', 'POST', { telegramId: parts[1], amount, adminKey: ADMIN_KEY });
    await sendMessage(chatId, r.success
      ? `✅ <b>${amount} коинов</b> → <code>${parts[1]}</code>\nБаланс: ${r.coins} коинов`
      : '❌ ' + (r.error || 'Ошибка')
    );
    return;
  }

  if (text === '/users') {
    const r = await localRequest('/admin/users?adminKey=' + ADMIN_KEY);
    if (!Array.isArray(r) || !r.length) { await sendMessage(chatId, '👥 Игроков нет'); return; }
    const list = r.slice(0, 20).map(u =>
      `• ${u.name} (<code>${u.id}</code>): ${u.coins} 🪙 | ${u.ucWon} UC выиграно | ${u.ucPending} UC ожидает`
    ).join('\n');
    await sendMessage(chatId, `👥 <b>Игроки (${r.length}):</b>\n\n${list}`);
    return;
  }
}

// Called from user-bot when winner sends PUBG ID
function receivePubgId(telegramId, pubgId, uc, prize, name) {
  pendingPubgIds[telegramId] = { pubgId, uc, prize, name, timestamp: Date.now() };
  notifyAdmin(
    `🎮 <b>PUBG ID от победителя!</b>\n\n` +
    `👤 ${name} (<code>${telegramId}</code>)\n` +
    `🏆 Приз: ${prize}\n` +
    `🎯 PUBG ID: <code>${pubgId}</code>\n\n` +
    `После зачисления UC нажми ✅`,
    [[
      { text: '✅ UC зачислено', callback_data: `uc_done_${telegramId}` },
      { text: '❌ Отклонить', callback_data: `uc_reject_${telegramId}` }
    ]]
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
        try { await handleUpdate(update); } catch(e) { console.error('Admin bot error:', e.message); }
      }
    }
  } catch(e) {
    console.error('Admin poll error:', e.message);
    await new Promise(r => setTimeout(r, 3000));
  }
  setImmediate(poll);
}

async function notifyAdmin(text, keyboard) {
  if (!ADMIN_CHAT_ID || !ADMIN_BOT_TOKEN) return;
  try { await sendMessage(ADMIN_CHAT_ID, text, keyboard); } catch(e) {}
}

module.exports = { poll, notifyAdmin, pendingPayments, pendingPubgIds, receivePubgId };
