const https = require('https');
const http = require('http');

const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BACKEND_URL = 'http://localhost:' + (process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY;

const pendingPayments = {};
const pendingPubgIds = {};
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

function send(chatId, text, keyboard) {
  const data = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) data.reply_markup = { inline_keyboard: keyboard };
  return tgRequest('sendMessage', data);
}

function answerCb(id, text) {
  return tgRequest('answerCallbackQuery', { callback_query_id: id, text });
}

function api(path, method, body) {
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
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    if (String(chatId) !== String(ADMIN_CHAT_ID)) { await answerCb(cb.id, '❌ Нет доступа'); return; }
    const data = cb.data;

    // Confirm coins
    if (data.startsWith('confirm_')) {
      const parts = data.replace('confirm_', '').split('_');
      const telegramId = parts[0];
      const count = parseInt(parts[1]);
      const payment = pendingPayments[telegramId];
      const amount = count || payment?.packCount;
      if (!amount) { await answerCb(cb.id, '❌ Заявка не найдена'); return; }
      const result = await api('/add-coins', 'POST', { telegramId, name: payment?.name, amount, adminKey: ADMIN_KEY });
      if (result.success) {
        delete pendingPayments[telegramId];
        await answerCb(cb.id, '✅ Зачислено!');
        await send(chatId, `✅ <b>${amount} коинов зачислено</b>\nИгрок: ${payment?.name || telegramId}\nБаланс: ${result.coins} 🪙`);
        try { require('./user-bot').notifyUserCoinsAdded(telegramId, amount, result.coins); } catch(e) {}
      } else { await answerCb(cb.id, '❌ ' + (result.error || 'Ошибка')); }
      return;
    }

    // Reject coins
    if (data.startsWith('reject_')) {
      const telegramId = data.replace('reject_', '');
      const payment = pendingPayments[telegramId];
      delete pendingPayments[telegramId];
      await answerCb(cb.id, '❌ Отклонено');
      await send(chatId, `❌ Заявка от ${payment?.name || telegramId} отклонена`);
      try { require('./user-bot').notifyUserRejected(telegramId); } catch(e) {}
      return;
    }

    // UC done
    if (data.startsWith('uc_done_')) {
      const telegramId = data.replace('uc_done_', '');
      const pending = pendingPubgIds[telegramId];
      if (!pending) { await answerCb(cb.id, '❌ Данные не найдены'); return; }
      const result = await api('/mark-withdrawn', 'POST', { telegramId, uc: pending.uc, adminKey: ADMIN_KEY });
      if (result.success) {
        await answerCb(cb.id, '✅ Выдано!');
        await send(chatId, `✅ <b>${pending.uc} UC выдано</b>\nПобедитель: <code>${telegramId}</code>\nPUBG ID: <code>${pending.pubgId}</code>`);
        delete pendingPubgIds[telegramId];
        try { require('./user-bot').notifyUserUCDone(telegramId, pending.uc); } catch(e) {}
      } else { await answerCb(cb.id, '❌ Ошибка'); }
      return;
    }

    // UC reject
    if (data.startsWith('uc_reject_')) {
      const telegramId = data.replace('uc_reject_', '');
      delete pendingPubgIds[telegramId];
      await answerCb(cb.id, '❌ Отклонено');
      try { require('./user-bot').notifyUserRejected(telegramId); } catch(e) {}
      return;
    }

    // Stats
    if (data === 'stats') {
      const result = await api('/admin/stats?adminKey=' + ADMIN_KEY);
      await answerCb(cb.id, '📊');
      await send(chatId,
        `📊 <b>Дашборд</b>\n\n` +
        `👥 Игроков: ${result.totalUsers || 0}\n` +
        `💰 Выручка: ${(result.totalRevenue || 0).toLocaleString('ru-RU')} сум\n` +
        `🪙 Коинов у игроков: ${result.totalCoinsLeft || 0}\n` +
        `🎮 Аукционов: ${result.totalAuctions || 0}\n\n` +
        `🏆 Топ игроков:\n${(result.topUsers || []).slice(0, 3).map((u, i) => `${i+1}. ${u.name}: ${u.wins} побед, ${u.ucWon} UC`).join('\n')}`,
        [[{ text: '🔄 Обновить', callback_data: 'stats' }]]
      );
      return;
    }

    // Start vote
    if (data === 'start_vote') {
      const result = await api('/start-vote', 'POST', { adminKey: ADMIN_KEY });
      await answerCb(cb.id, result.success ? '🗳 Голосование запущено!' : '❌ ' + (result.error || 'Ошибка'));
      return;
    }

    // Start auction manually
    if (data === 'start_auction') {
      await answerCb(cb.id, 'Выбери лот');
      await send(chatId, `🎮 <b>Выбери лот:</b>`, [
        [{ text: '💙 325 UC — 55,000 сум', callback_data: 'launch_325' }],
        [{ text: '💎 660 UC — 96,000 сум', callback_data: 'launch_660' }],
        [{ text: '👑 1800 UC — 245,000 сум', callback_data: 'launch_1800' }]
      ]);
      return;
    }

    if (data.startsWith('launch_')) {
      const lotKey = data.replace('launch_', '');
      const result = await api('/start-auction', 'POST', { lotKey, adminKey: ADMIN_KEY });
      await answerCb(cb.id, result.success ? '🚀 Запущен!' : '❌ ' + (result.error || 'Ошибка'));
      return;
    }

    // Settings menu
    if (data === 'settings') {
      const s = await api('/settings?adminKey=' + ADMIN_KEY);
      await answerCb(cb.id, '⚙️');
      await send(chatId,
        `⚙️ <b>Настройки</b>\n\n` +
        `🪙 Стоимость коина: ${s.coinCost} сум\n` +
        `📈 Шаг цены за ставку: ${s.bidIncrement} сум\n` +
        `⏱ Таймер: ${s.timerSeconds} сек\n` +
        `⚡ +сек за ставку: ${s.timerAddPerBid} сек\n` +
        `🗳 Голосов для старта: ${s.votesRequired}\n` +
        `⏳ Задержка старта: ${s.auctionStartDelay} сек\n` +
        `🎯 Мин. ставок: ${s.minBids}\n` +
        `💯 Макс. скидка: ${s.maxDiscount} сум\n\n` +
        `Для изменения: /set [ключ] [значение]\n` +
        `Пример: /set coinCost 300`,
        [[
          { text: '🎮 Лоты', callback_data: 'edit_lots' },
          { text: '🔄 Обновить', callback_data: 'settings' }
        ]]
      );
      return;
    }

    // Edit lots
    if (data === 'edit_lots') {
      const s = await api('/settings?adminKey=' + ADMIN_KEY);
      const lots = s.lots || {};
      const text = Object.entries(lots).map(([k, l]) =>
        `${l.prize}: ${l.marketPrice.toLocaleString('ru-RU')} сум`
      ).join('\n');
      await answerCb(cb.id, '🎮');
      await send(chatId,
        `🎮 <b>Текущие лоты:</b>\n\n${text}\n\n` +
        `Для изменения цены:\n/setlot [ключ] [цена]\nПример: /setlot 660 100000`
      );
      return;
    }

    // Promos list
    if (data === 'promos') {
      const result = await api('/promos?adminKey=' + ADMIN_KEY);
      if (!Array.isArray(result) || !result.length) {
        await answerCb(cb.id, 'Нет промокодов');
        await send(chatId, '📋 Промокодов нет.\n\nСоздать: /promo [код] [коины] [кол-во использований]\nПример: /promo GIFT10 10 100');
        return;
      }
      await answerCb(cb.id, '📋');
      const list = result.map(p =>
        `<code>${p.code}</code> — ${p.coins} 🪙 | ${p.usedCount}/${p.maxUses} | ${p.active ? '✅' : '❌'}`
      ).join('\n');
      await send(chatId, `📋 <b>Промокоды:</b>\n\n${list}\n\nУдалить: /delpromo [код]`);
      return;
    }

    return;
  }

  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const isAdmin = String(chatId) === String(ADMIN_CHAT_ID);
  const text = (msg.text || '').trim();

  if (!isAdmin) { await send(chatId, '❌ Только для администратора.'); return; }

  if (text === '/start') {
    await send(chatId,
      `👋 <b>UC Auction Admin v3</b>\n\n` +
      `Команды:\n` +
      `/stats — дашборд\n` +
      `/users — игроки\n` +
      `/add [id] [кол-во] — коины\n` +
      `/set [ключ] [значение] — настройки\n` +
      `/setlot [ключ] [цена] — цена лота\n` +
      `/promo [код] [коины] [использований] — создать промокод\n` +
      `/delpromo [код] — удалить промокод\n` +
      `/stop — остановить аукцион`,
      [[
        { text: '🗳 Голосование', callback_data: 'start_vote' },
        { text: '🚀 Аукцион', callback_data: 'start_auction' }
      ], [
        { text: '📊 Статистика', callback_data: 'stats' },
        { text: '⚙️ Настройки', callback_data: 'settings' }
      ], [
        { text: '🎟 Промокоды', callback_data: 'promos' }
      ]]
    );
    return;
  }

  if (text === '/stats') {
    const result = await api('/admin/stats?adminKey=' + ADMIN_KEY);
    await send(chatId,
      `📊 <b>Дашборд</b>\n\n` +
      `👥 Игроков: ${result.totalUsers || 0}\n` +
      `💰 Выручка: ${(result.totalRevenue || 0).toLocaleString('ru-RU')} сум\n` +
      `🪙 Коинов у игроков: ${result.totalCoinsLeft || 0}\n` +
      `🎮 Аукционов: ${result.totalAuctions || 0}`,
      [[{ text: '🔄 Обновить', callback_data: 'stats' }]]
    );
    return;
  }

  if (text === '/stop') {
    const r = await api('/stop-auction', 'POST', { adminKey: ADMIN_KEY });
    await send(chatId, r.success ? '✅ Аукцион остановлен' : '❌ ' + (r.error || 'Ошибка'));
    return;
  }

  if (text.startsWith('/add ')) {
    const parts = text.split(' ');
    if (parts.length < 3) { await send(chatId, '❌ /add [telegramId] [количество]'); return; }
    const amount = parseInt(parts[2]);
    if (!amount) { await send(chatId, '❌ Неверное количество'); return; }
    const r = await api('/add-coins', 'POST', { telegramId: parts[1], amount, adminKey: ADMIN_KEY });
    await send(chatId, r.success ? `✅ ${amount} коинов → <code>${parts[1]}</code>\nБаланс: ${r.coins} 🪙` : '❌ ' + (r.error || 'Ошибка'));
    return;
  }

  if (text.startsWith('/set ')) {
    const parts = text.split(' ');
    if (parts.length < 3) { await send(chatId, '❌ /set [ключ] [значение]'); return; }
    const key = parts[1];
    const value = isNaN(parts[2]) ? parts[2] : Number(parts[2]);
    const allowed = ['coinCost','bidIncrement','minBids','maxDiscount','timerSeconds','timerAddPerBid','votesRequired','auctionStartDelay'];
    if (!allowed.includes(key)) { await send(chatId, `❌ Допустимые ключи:\n${allowed.join(', ')}`); return; }
    const r = await api('/update-setting', 'POST', { key, value, adminKey: ADMIN_KEY });
    await send(chatId, r.success ? `✅ ${key} = ${value}` : '❌ Ошибка');
    return;
  }

  if (text.startsWith('/setlot ')) {
    const parts = text.split(' ');
    if (parts.length < 3) { await send(chatId, '❌ /setlot [ключ] [цена]\nПример: /setlot 660 100000'); return; }
    const lotKey = parts[1];
    const price = parseInt(parts[2]);
    const s = await api('/settings?adminKey=' + ADMIN_KEY);
    const lots = s.lots || {};
    if (!lots[lotKey]) { await send(chatId, '❌ Лот не найден. Доступные: ' + Object.keys(lots).join(', ')); return; }
    lots[lotKey].marketPrice = price;
    const r = await api('/update-setting', 'POST', { key: 'lots', value: lots, adminKey: ADMIN_KEY });
    await send(chatId, r.success ? `✅ ${lots[lotKey].prize}: цена = ${price.toLocaleString('ru-RU')} сум` : '❌ Ошибка');
    return;
  }

  if (text.startsWith('/promo ')) {
    const parts = text.split(' ');
    if (parts.length < 4) { await send(chatId, '❌ /promo [код] [коины] [кол-во]\nПример: /promo GIFT10 10 100'); return; }
    const r = await api('/create-promo', 'POST', { code: parts[1], coins: parseInt(parts[2]), maxUses: parseInt(parts[3]), adminKey: ADMIN_KEY });
    await send(chatId, r.success ? `✅ Промокод <code>${parts[1].toUpperCase()}</code> создан\n🪙 ${parts[2]} коинов × ${parts[3]} использований` : '❌ ' + (r.error || 'Ошибка'));
    return;
  }

  if (text.startsWith('/delpromo ')) {
    const code = text.split(' ')[1];
    const r = await api(`/promo/${code}?adminKey=${ADMIN_KEY}`, 'DELETE');
    await send(chatId, r.success ? `✅ Промокод <code>${code.toUpperCase()}</code> удалён` : '❌ Ошибка');
    return;
  }

  if (text === '/users') {
    const r = await api('/admin/users?adminKey=' + ADMIN_KEY);
    if (!Array.isArray(r) || !r.length) { await send(chatId, '👥 Нет игроков'); return; }
    const list = r.slice(0, 15).map(u =>
      `• ${u.name} (<code>${u.telegramId}</code>): ${u.coins}🪙 ${u.wins}🏆 ${u.ucWon}UC`
    ).join('\n');
    await send(chatId, `👥 <b>Игроки (${r.length}):</b>\n\n${list}`);
    return;
  }
}

function receivePubgId(telegramId, pubgId, uc, prize, name) {
  pendingPubgIds[telegramId] = { pubgId, uc, prize, name, timestamp: Date.now() };
  notifyAdmin(
    `🎮 <b>PUBG ID от победителя!</b>\n\n` +
    `👤 ${name} (<code>${telegramId}</code>)\n` +
    `🏆 Приз: ${prize}\n` +
    `🎯 PUBG ID: <code>${pubgId}</code>`,
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
        try { await handleUpdate(update); } catch(e) { console.error('Admin error:', e.message); }
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
  try { await send(ADMIN_CHAT_ID, text, keyboard); } catch(e) {}
}

module.exports = { poll, notifyAdmin, pendingPayments, pendingPubgIds, receivePubgId };
