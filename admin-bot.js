const https = require('https');
const http = require('http');

const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BACKEND_URL = 'http://localhost:' + (process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY;

const pendingPayments = {};
const pendingPubgIds = {};
let lastUpdateId = 0;

// What we're waiting for a plain-text reply to fill in, for the button-driven
// flows below (add coins, edit a setting, create a promo). There's only ever
// one admin chat, so a single variable is enough — no per-user map needed.
let pending = null;

const SETTING_FIELDS = [
  { key: 'coinCost', label: 'Цена коина (сум)' },
  { key: 'bidIncrement', label: 'Шаг цены за ставку (сум)' },
  { key: 'timerSeconds', label: 'Таймер аукциона (сек)' },
  { key: 'timerAddPerBid', label: '+сек за ставку' },
  { key: 'votesRequired', label: 'Голосов для старта' },
  { key: 'auctionStartDelay', label: 'Задержка старта (сек)' },
  { key: 'minBids', label: 'Мин. ставок' },
  { key: 'maxDiscount', label: 'Скидка проигравшим (сум)' },
];

const LOT_ICONS = { '325': '💙', '660': '💎', '1800': '👑' };
const DIRECT_ICONS = { uc60: '💙', uc325: '💜', uc660: '💎', uc1800: '👑' };
const QUICK_COINS = [50, 100, 500, 1000];
const QUICK_PROMO_COINS = [5, 10, 20, 50, 100];
const QUICK_PROMO_USES = [10, 50, 100, 500];

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

function mainMenuKeyboard() {
  return [
    [{ text: '🗳 Голосование', callback_data: 'start_vote' }, { text: '🚀 Аукцион', callback_data: 'start_auction' }],
    [{ text: '🪙 Выдать коины', callback_data: 'give_coins' }, { text: '📊 Статистика', callback_data: 'stats' }],
    [{ text: '⚙️ Настройки', callback_data: 'settings' }, { text: '🎮 Лоты аукциона', callback_data: 'edit_lots' }],
    [{ text: '💎 Цены прямой покупки', callback_data: 'edit_direct' }, { text: '🎟 Промокоды', callback_data: 'promos' }],
    [{ text: '👥 Игроки', callback_data: 'users_list' }, { text: '🛑 Стоп аукцион', callback_data: 'stop_auction' }],
  ];
}

function backRow() {
  return [{ text: '⬅️ Меню', callback_data: 'menu' }];
}

function cancelRow() {
  return [{ text: '❌ Отмена', callback_data: 'cancel_pending' }];
}

function quickCoinsButtons() {
  return [
    QUICK_COINS.slice(0, 2).map(n => ({ text: `${n} 🪙`, callback_data: `qc_${n}` })),
    QUICK_COINS.slice(2).map(n => ({ text: `${n} 🪙`, callback_data: `qc_${n}` })),
    [{ text: '✏️ Другое количество', callback_data: 'addcoins_custom' }],
    cancelRow()
  ];
}

function quickPromoCoinsButtons() {
  return [
    QUICK_PROMO_COINS.slice(0, 3).map(n => ({ text: String(n), callback_data: `pcoins_${n}` })),
    QUICK_PROMO_COINS.slice(3).map(n => ({ text: String(n), callback_data: `pcoins_${n}` })),
    [{ text: '✏️ Другое', callback_data: 'pcoins_custom' }],
    cancelRow()
  ];
}

function quickPromoUsesButtons() {
  return [
    QUICK_PROMO_USES.map(n => ({ text: String(n), callback_data: `puses_${n}` })),
    [{ text: '✏️ Другое', callback_data: 'puses_custom' }],
    cancelRow()
  ];
}

async function applyAddCoins(chatId, telegramId, amount) {
  const r = await api('/add-coins', 'POST', { telegramId, amount, adminKey: ADMIN_KEY });
  await send(chatId,
    r.success ? `✅ ${amount} коинов → <code>${telegramId}</code>\nБаланс: ${r.coins} 🪙` : '❌ ' + (r.error || 'Ошибка'),
    [backRow()]
  );
}

async function createPromoFlow(chatId, code, coins, maxUses) {
  const r = await api('/create-promo', 'POST', { code, coins, maxUses, adminKey: ADMIN_KEY });
  await send(chatId,
    r.success ? `✅ Промокод <code>${code}</code> создан\n🪙 ${coins} коинов × ${maxUses} использований` : '❌ ' + (r.error || 'Ошибка'),
    [backRow()]
  );
}

// Handles a plain-text reply while a button flow is waiting on one.
// Returns true if it consumed the message, false if there's nothing pending.
async function handlePendingText(chatId, text) {
  const p = pending;
  if (!p) return false;

  if (p.type === 'addcoins_id') {
    if (!/^\d+$/.test(text)) { await send(chatId, '❌ ID должен быть числом. Введи Telegram ID игрока:', [cancelRow()]); return true; }
    pending = { type: 'addcoins_amount', id: text };
    await send(chatId, '🪙 Сколько коинов зачислить?', quickCoinsButtons());
    return true;
  }

  if (p.type === 'addcoins_amount') {
    const amount = parseInt(text);
    if (isNaN(amount) || amount <= 0) { await send(chatId, '❌ Введи положительное число:', [cancelRow()]); return true; }
    pending = null;
    await applyAddCoins(chatId, p.id, amount);
    return true;
  }

  if (p.type === 'setting') {
    const value = isNaN(text) ? text : Number(text);
    pending = null;
    const r = await api('/update-setting', 'POST', { key: p.key, value, adminKey: ADMIN_KEY });
    await send(chatId, r.success ? `✅ ${p.label} = ${value}` : '❌ Ошибка', [backRow()]);
    return true;
  }

  if (p.type === 'lot') {
    const value = parseInt(text);
    if (isNaN(value) || value <= 0) { await send(chatId, '❌ Введи положительное число:', [cancelRow()]); return true; }
    pending = null;
    const s = await api('/settings?adminKey=' + ADMIN_KEY);
    const lots = s.lots || {};
    if (!lots[p.lotKey]) { await send(chatId, '❌ Лот не найден', [backRow()]); return true; }
    if (p.field === 'price') lots[p.lotKey].marketPrice = value; else lots[p.lotKey].bidCoins = value;
    const r = await api('/update-setting', 'POST', { key: 'lots', value: lots, adminKey: ADMIN_KEY });
    await send(chatId,
      r.success ? `✅ ${lots[p.lotKey].prize}: ${p.field === 'price' ? 'цена' : 'ставка'} = ${value.toLocaleString('ru-RU')}` : '❌ Ошибка',
      [backRow()]
    );
    return true;
  }

  if (p.type === 'direct') {
    const value = parseInt(text);
    if (isNaN(value) || value <= 0) { await send(chatId, '❌ Введи положительное число:', [cancelRow()]); return true; }
    pending = null;
    const s = await api('/settings?adminKey=' + ADMIN_KEY);
    const direct = s.directPrices || {};
    if (!direct[p.item]) { await send(chatId, '❌ Позиция не найдена', [backRow()]); return true; }
    direct[p.item].price = value;
    const r = await api('/update-setting', 'POST', { key: 'directPrices', value: direct, adminKey: ADMIN_KEY });
    await send(chatId,
      r.success ? `✅ ${direct[p.item].uc} UC: цена = ${value.toLocaleString('ru-RU')} сум` : '❌ Ошибка',
      [backRow()]
    );
    return true;
  }

  if (p.type === 'promo_code') {
    const code = text.toUpperCase().replace(/\s+/g, '');
    if (!code) { await send(chatId, '❌ Введи код:', [cancelRow()]); return true; }
    pending = { type: 'promo_coins', code };
    await send(chatId, `🪙 Сколько коинов даёт код <code>${code}</code>?`, quickPromoCoinsButtons());
    return true;
  }

  if (p.type === 'promo_coins_custom') {
    const coins = parseInt(text);
    if (isNaN(coins) || coins <= 0) { await send(chatId, '❌ Введи положительное число:', [cancelRow()]); return true; }
    pending = { type: 'promo_uses', code: p.code, coins };
    await send(chatId, '🔢 Сколько раз можно использовать?', quickPromoUsesButtons());
    return true;
  }

  if (p.type === 'promo_uses_custom') {
    const maxUses = parseInt(text);
    if (isNaN(maxUses) || maxUses <= 0) { await send(chatId, '❌ Введи положительное число:', [cancelRow()]); return true; }
    pending = null;
    await createPromoFlow(chatId, p.code, p.coins, maxUses);
    return true;
  }

  return false;
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
      const p = pendingPubgIds[telegramId];
      if (!p) { await answerCb(cb.id, '❌ Данные не найдены'); return; }
      const result = await api('/mark-withdrawn', 'POST', { telegramId, uc: p.uc, adminKey: ADMIN_KEY });
      if (result.success) {
        await answerCb(cb.id, '✅ Выдано!');
        await send(chatId, `✅ <b>${p.uc} UC выдано</b>\nПобедитель: <code>${telegramId}</code>\nPUBG ID: <code>${p.pubgId}</code>`);
        delete pendingPubgIds[telegramId];
        try { require('./user-bot').notifyUserUCDone(telegramId, p.uc); } catch(e) {}
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

    // ---- Main menu navigation ----
    if (data === 'menu') {
      pending = null;
      await answerCb(cb.id);
      await send(chatId, '👋 <b>UC Auction Admin</b>\n\nВыбери действие:', mainMenuKeyboard());
      return;
    }

    if (data === 'cancel_pending') {
      pending = null;
      await answerCb(cb.id, 'Отменено');
      await send(chatId, '👋 <b>UC Auction Admin</b>\n\nВыбери действие:', mainMenuKeyboard());
      return;
    }

    // ---- Give coins ----
    if (data === 'give_coins') {
      pending = { type: 'addcoins_id' };
      await answerCb(cb.id);
      await send(chatId, '🆔 Введи Telegram ID игрока:', [cancelRow()]);
      return;
    }

    if (data.startsWith('qc_')) {
      if (pending?.type !== 'addcoins_amount') { await answerCb(cb.id); return; }
      const amount = parseInt(data.replace('qc_', ''));
      const telegramId = pending.id;
      pending = null;
      await answerCb(cb.id);
      await applyAddCoins(chatId, telegramId, amount);
      return;
    }

    if (data === 'addcoins_custom') {
      if (pending?.type !== 'addcoins_amount') { await answerCb(cb.id); return; }
      await answerCb(cb.id);
      await send(chatId, '🔢 Введи количество коинов:', [cancelRow()]);
      return;
    }

    // ---- Stats ----
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
        [[{ text: '🔄 Обновить', callback_data: 'stats' }], backRow()]
      );
      return;
    }

    // ---- Players ----
    if (data === 'users_list') {
      const r = await api('/admin/users?adminKey=' + ADMIN_KEY);
      await answerCb(cb.id);
      if (!Array.isArray(r) || !r.length) { await send(chatId, '👥 Нет игроков', [backRow()]); return; }
      const list = r.slice(0, 15).map(u => `• ${u.name} (<code>${u.telegramId}</code>): ${u.coins}🪙 ${u.wins}🏆 ${u.ucWon}UC`).join('\n');
      await send(chatId, `👥 <b>Игроки (${r.length}):</b>\n\n${list}`, [backRow()]);
      return;
    }

    // ---- Voting / auction ----
    if (data === 'start_vote') {
      const result = await api('/start-vote', 'POST', { adminKey: ADMIN_KEY });
      await answerCb(cb.id, result.success ? '🗳 Голосование запущено!' : '❌ ' + (result.error || 'Ошибка'));
      return;
    }

    if (data === 'start_auction') {
      const s = await api('/settings?adminKey=' + ADMIN_KEY);
      const lots = s.lots || {};
      const buttons = Object.entries(lots).map(([key, lot]) => ([{
        text: `${LOT_ICONS[key] || '🎮'} ${lot.prize} — ${(lot.marketPrice || 0).toLocaleString('ru-RU')} сум`,
        callback_data: `launch_${key}`
      }]));
      buttons.push(backRow());
      await answerCb(cb.id, 'Выбери лот');
      await send(chatId, `🎮 <b>Выбери лот:</b>`, buttons);
      return;
    }

    if (data.startsWith('launch_')) {
      const lotKey = data.replace('launch_', '');
      const result = await api('/start-auction', 'POST', { lotKey, adminKey: ADMIN_KEY });
      await answerCb(cb.id, result.success ? '🚀 Запущен!' : '❌ ' + (result.error || 'Ошибка'));
      return;
    }

    if (data === 'stop_auction') {
      const r = await api('/stop-auction', 'POST', { adminKey: ADMIN_KEY });
      await answerCb(cb.id, r.success ? '✅ Остановлен' : '❌ ' + (r.error || 'Ошибка'));
      if (r.success) await send(chatId, '✅ Аукцион остановлен', [backRow()]);
      return;
    }

    // ---- Settings ----
    if (data === 'settings') {
      const s = await api('/settings?adminKey=' + ADMIN_KEY);
      await answerCb(cb.id, '⚙️');
      const rows = SETTING_FIELDS.map(f => ([{ text: `${f.label}: ${s[f.key]}`, callback_data: `setfield_${f.key}` }]));
      rows.push(backRow());
      await send(chatId, `⚙️ <b>Настройки</b>\n\nНажми на пункт, чтобы изменить:`, rows);
      return;
    }

    if (data.startsWith('setfield_')) {
      const key = data.replace('setfield_', '');
      const field = SETTING_FIELDS.find(f => f.key === key);
      if (!field) { await answerCb(cb.id); return; }
      pending = { type: 'setting', key, label: field.label };
      await answerCb(cb.id);
      await send(chatId, `✏️ Введи новое значение для «${field.label}»:`, [cancelRow()]);
      return;
    }

    // ---- Auction lots ----
    if (data === 'edit_lots') {
      const s = await api('/settings?adminKey=' + ADMIN_KEY);
      const lots = s.lots || {};
      await answerCb(cb.id, '🎮');
      const rows = Object.entries(lots).map(([key, lot]) => ([{
        text: `${LOT_ICONS[key] || '🎮'} ${lot.prize} — ${(lot.marketPrice || 0).toLocaleString('ru-RU')} сум | ${lot.bidCoins || 1}🪙/ставка`,
        callback_data: `lotpick_${key}`
      }]));
      rows.push(backRow());
      await send(chatId, `🎮 <b>Лоты аукциона</b>\n\nВыбери лот для изменения:`, rows);
      return;
    }

    if (data.startsWith('lotpick_')) {
      const lotKey = data.replace('lotpick_', '');
      await answerCb(cb.id);
      await send(chatId, `${LOT_ICONS[lotKey] || '🎮'} Лот ${lotKey} UC — что изменить?`, [
        [{ text: '💰 Цена', callback_data: `lotfield_${lotKey}_price` }],
        [{ text: '🪙 Стоимость ставки', callback_data: `lotfield_${lotKey}_coins` }],
        [{ text: '⬅️ Назад', callback_data: 'edit_lots' }]
      ]);
      return;
    }

    if (data.startsWith('lotfield_')) {
      const match = data.match(/^lotfield_(.+)_(price|coins)$/);
      if (!match) { await answerCb(cb.id); return; }
      const [, lotKey, fieldName] = match;
      pending = { type: 'lot', lotKey, field: fieldName };
      await answerCb(cb.id);
      await send(chatId,
        fieldName === 'price' ? `💰 Введи новую цену для лота ${lotKey}:` : `🪙 Введи новую стоимость ставки для лота ${lotKey} (в коинах):`,
        [cancelRow()]
      );
      return;
    }

    // ---- Direct-purchase prices ----
    if (data === 'edit_direct') {
      const s = await api('/settings?adminKey=' + ADMIN_KEY);
      const direct = s.directPrices || {};
      await answerCb(cb.id, '💎');
      const rows = Object.entries(direct).map(([id, item]) => ([{
        text: `${DIRECT_ICONS[id] || '💎'} ${item.uc} UC — ${(item.price || 0).toLocaleString('ru-RU')} сум`,
        callback_data: `directpick_${id}`
      }]));
      rows.push(backRow());
      await send(chatId, `💎 <b>Прямая покупка UC</b>\n\nВыбери позицию для изменения цены:`, rows);
      return;
    }

    if (data.startsWith('directpick_')) {
      const item = data.replace('directpick_', '');
      pending = { type: 'direct', item };
      await answerCb(cb.id);
      await send(chatId, `💎 Введи новую цену для ${item}:`, [cancelRow()]);
      return;
    }

    // ---- Promo codes ----
    if (data === 'promos') {
      const result = await api('/promos?adminKey=' + ADMIN_KEY);
      await answerCb(cb.id, '📋');
      if (!Array.isArray(result) || !result.length) {
        await send(chatId, '📋 Промокодов пока нет.', [[{ text: '➕ Новый промокод', callback_data: 'new_promo' }], backRow()]);
        return;
      }
      const list = result.map(p => `<code>${p.code}</code> — ${p.coins} 🪙 | ${p.usedCount}/${p.maxUses} | ${p.active ? '✅' : '❌'}`).join('\n');
      const delButtons = result.slice(0, 10).map(p => ([{ text: `🗑 ${p.code}`, callback_data: `delpromo_${p.code}` }]));
      await send(chatId, `📋 <b>Промокоды:</b>\n\n${list}`, [
        [{ text: '➕ Новый промокод', callback_data: 'new_promo' }],
        ...delButtons,
        backRow()
      ]);
      return;
    }

    if (data === 'new_promo') {
      pending = { type: 'promo_code' };
      await answerCb(cb.id);
      await send(chatId, '🎟 Введи код промокода (например GIFT10):', [cancelRow()]);
      return;
    }

    if (data.startsWith('pcoins_')) {
      if (pending?.type !== 'promo_coins') { await answerCb(cb.id); return; }
      const coins = parseInt(data.replace('pcoins_', ''));
      const code = pending.code;
      pending = { type: 'promo_uses', code, coins };
      await answerCb(cb.id);
      await send(chatId, '🔢 Сколько раз можно использовать?', quickPromoUsesButtons());
      return;
    }

    if (data === 'pcoins_custom') {
      if (pending?.type !== 'promo_coins') { await answerCb(cb.id); return; }
      pending = { type: 'promo_coins_custom', code: pending.code };
      await answerCb(cb.id);
      await send(chatId, '🔢 Введи количество коинов:', [cancelRow()]);
      return;
    }

    if (data.startsWith('puses_')) {
      if (pending?.type !== 'promo_uses') { await answerCb(cb.id); return; }
      const maxUses = parseInt(data.replace('puses_', ''));
      const { code, coins } = pending;
      pending = null;
      await answerCb(cb.id);
      await createPromoFlow(chatId, code, coins, maxUses);
      return;
    }

    if (data === 'puses_custom') {
      if (pending?.type !== 'promo_uses') { await answerCb(cb.id); return; }
      pending = { type: 'promo_uses_custom', code: pending.code, coins: pending.coins };
      await answerCb(cb.id);
      await send(chatId, '🔢 Введи максимальное число использований:', [cancelRow()]);
      return;
    }

    if (data.startsWith('delpromo_')) {
      const code = data.replace('delpromo_', '');
      const r = await api(`/promo/${code}?adminKey=${ADMIN_KEY}`, 'DELETE');
      await answerCb(cb.id, r.success ? '✅ Удалён' : '❌ Ошибка');
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

  // A button flow waiting on typed input gets first refusal on any non-command text.
  if (pending && text && !text.startsWith('/')) {
    if (await handlePendingText(chatId, text)) return;
  }

  if (text === '/start') {
    pending = null;
    await send(chatId,
      `👋 <b>UC Auction Admin</b>\n\n` +
      `Всё управление — через кнопки ниже. Текстовые команды тоже работают, если привычнее:\n` +
      `/stats /users /add /set /setlot /setprice /promo /delpromo /stop`,
      mainMenuKeyboard()
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
      [[{ text: '🔄 Обновить', callback_data: 'stats' }], backRow()]
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
    const allowed = SETTING_FIELDS.map(f => f.key);
    if (!allowed.includes(key)) { await send(chatId, `❌ Допустимые ключи:\n${allowed.join(', ')}`); return; }
    const r = await api('/update-setting', 'POST', { key, value, adminKey: ADMIN_KEY });
    await send(chatId, r.success ? `✅ ${key} = ${value}` : '❌ Ошибка');
    return;
  }

  if (text.startsWith('/setlot ')) {
    const parts = text.split(' ');
    if (parts.length < 3) {
      await send(chatId,
        '❌ Формат:\n' +
        '/setlot [ключ] price [цена] — изменить рыночную цену\n' +
        '/setlot [ключ] coins [кол-во] — изменить стоимость ставки в коинах\n\n' +
        'Примеры:\n' +
        '/setlot 660 price 120000\n' +
        '/setlot 660 coins 3\n' +
        '/setlot 1800 coins 5'
      );
      return;
    }
    const lotKey = parts[1];
    const param = parts[2];
    const value = parseInt(parts[3]);
    if (isNaN(value) || value <= 0) { await send(chatId, '❌ Значение должно быть положительным числом'); return; }
    const s = await api('/settings?adminKey=' + ADMIN_KEY);
    const lots = s.lots || {};
    if (!lots[lotKey]) { await send(chatId, '❌ Лот не найден. Доступные: ' + Object.keys(lots).join(', ')); return; }
    if (param === 'price') {
      lots[lotKey].marketPrice = value;
      const r = await api('/update-setting', 'POST', { key: 'lots', value: lots, adminKey: ADMIN_KEY });
      await send(chatId, r.success ? `✅ ${lots[lotKey].prize}: цена = ${value.toLocaleString('ru-RU')} сум` : '❌ Ошибка');
    } else if (param === 'coins') {
      lots[lotKey].bidCoins = value;
      const r = await api('/update-setting', 'POST', { key: 'lots', value: lots, adminKey: ADMIN_KEY });
      await send(chatId, r.success ? `✅ ${lots[lotKey].prize}: ставка = ${value} коин(а)` : '❌ Ошибка');
    } else {
      await send(chatId, '❌ Параметр должен быть price или coins');
    }
    return;
  }

  if (text.startsWith('/setprice ')) {
    const parts = text.split(' ');
    const item = parts[1];
    const value = parseInt(parts[2]);
    const allowedItems = ['uc60', 'uc325', 'uc660', 'uc1800'];
    if (!allowedItems.includes(item) || isNaN(value) || value <= 0) {
      await send(chatId,
        '❌ Формат: /setprice [uc60|uc325|uc660|uc1800] [цена]\n\n' +
        'Это цена прямой покупки UC (в обход аукциона) — отдельная от цен лотов аукциона.\n' +
        'Пример: /setprice uc660 120000'
      );
      return;
    }
    const s = await api('/settings?adminKey=' + ADMIN_KEY);
    const direct = s.directPrices || {};
    if (!direct[item]) { await send(chatId, '❌ Позиция не найдена'); return; }
    direct[item].price = value;
    const r = await api('/update-setting', 'POST', { key: 'directPrices', value: direct, adminKey: ADMIN_KEY });
    await send(chatId, r.success ? `✅ ${direct[item].uc} UC (прямая покупка): цена = ${value.toLocaleString('ru-RU')} сум` : '❌ Ошибка');
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
  let healthy = true;
  try {
    const res = await tgRequest('getUpdates', {
      offset: lastUpdateId + 1, timeout: 30,
      allowed_updates: ['message', 'callback_query']
    });
    if (res.ok === false) {
      console.error('Admin poll error:', res.description || 'unknown');
      healthy = false;
    } else if (res.result?.length) {
      for (const update of res.result) {
        lastUpdateId = update.update_id;
        try { await handleUpdate(update); } catch(e) { console.error('Admin error:', e.message); }
      }
    }
  } catch(e) {
    console.error('Admin poll error:', e.message);
    healthy = false;
  }
  // tgRequest never rejects on API errors (it resolves {ok:false}), so without
  // this explicit check a bad token/rate-limit used to retry with no backoff at all.
  if (healthy) setImmediate(poll);
  else setTimeout(poll, 3000);
}

async function notifyAdmin(text, keyboard) {
  if (!ADMIN_CHAT_ID || !ADMIN_BOT_TOKEN) return;
  try { await send(ADMIN_CHAT_ID, text, keyboard); } catch(e) {}
}

module.exports = { poll, notifyAdmin, pendingPayments, pendingPubgIds, receivePubgId };
