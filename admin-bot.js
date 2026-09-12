const https = require('https');

const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BACKEND_URL = 'http://localhost:' + (process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY;

// Telegram API helper
function tgRequest(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${ADMIN_BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text, keyboard) {
  const data = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) data.reply_markup = { inline_keyboard: keyboard };
  return tgRequest('sendMessage', data);
}

function answerCallback(callbackId, text) {
  return tgRequest('answerCallbackQuery', { callback_query_id: callbackId, text });
}

// HTTP helper for local backend
function localRequest(path, method, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const url = new URL(BACKEND_URL + path);
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + (url.search || ''),
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = require('http').request(options, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', () => resolve({ error: 'Ошибка подключения к серверу' }));
    if (data) req.write(data);
    req.end();
  });
}

// Pending payments: { telegramId: { name, packCount, packPrice, timestamp } }
const pendingPayments = {};

// Handle incoming update
async function handleUpdate(update) {
  // Callback query (button press)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;

    // Only admin can use admin commands
    if (String(chatId) !== String(ADMIN_CHAT_ID)) {
      await answerCallback(cb.id, '❌ Нет доступа');
      return;
    }

    if (data.startsWith('confirm_')) {
      const telegramId = data.replace('confirm_', '');
      const payment = pendingPayments[telegramId];
      if (!payment) {
        await answerCallback(cb.id, 'Заявка не найдена');
        return;
      }

      // Add bids via backend API
      const result = await localRequest('/add-bids', 'POST', {
        telegramId,
        name: payment.name,
        amount: payment.packCount,
        adminKey: ADMIN_KEY
      });

      if (result.success) {
        delete pendingPayments[telegramId];
        await answerCallback(cb.id, '✅ Зачислено!');
        await sendMessage(chatId, `✅ <b>Зачислено ${payment.packCount} ставок</b>\nПользователь: ${payment.name} (${telegramId})`);
      } else {
        await answerCallback(cb.id, '❌ Ошибка: ' + (result.error || 'неизвестно'));
      }
    }

    if (data.startsWith('reject_')) {
      const telegramId = data.replace('reject_', '');
      delete pendingPayments[telegramId];
      await answerCallback(cb.id, '❌ Отклонено');
      await sendMessage(chatId, `❌ Заявка от ${telegramId} отклонена`);
    }

    if (data === 'stats') {
      const result = await localRequest('/');
      await answerCallback(cb.id, 'Статистика загружена');
      await sendMessage(chatId,
        `📊 <b>Статистика аукциона</b>\n\n` +
        `🎮 Аукцион #${result.auctionId || '?'}: ${result.auctionActive ? '🟢 Активен' : '🔴 Завершён'}\n` +
        `👥 Пользователей: ${result.totalUsers || 0}\n` +
        `🔌 Подключено: ${result.connectedClients || 0}`
      );
    }

    return;
  }

  // Text message
  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const isAdmin = String(chatId) === String(ADMIN_CHAT_ID);

  // /start
  if (text === '/start') {
    if (isAdmin) {
      await sendMessage(chatId,
        `👋 <b>UC Auction Admin Bot</b>\n\n` +
        `Команды:\n` +
        `/stats — статистика\n` +
        `/add [id] [кол-во] — добавить ставки\n` +
        `/users — список пользователей\n\n` +
        `Когда игрок покупает ставки — ты получишь уведомление с кнопками подтвердить/отклонить.`,
        [[{ text: '📊 Статистика', callback_data: 'stats' }]]
      );
    } else {
      await sendMessage(chatId, '❌ Этот бот только для администратора.');
    }
    return;
  }

  // /stats
  if (text === '/stats' && isAdmin) {
    const result = await localRequest('/');
    await sendMessage(chatId,
      `📊 <b>Статистика</b>\n\n` +
      `🎮 Аукцион #${result.auctionId}: ${result.auctionActive ? '🟢 Активен' : '🔴 Завершён'}\n` +
      `👥 Пользователей: ${result.totalUsers || 0}\n` +
      `🔌 Онлайн: ${result.connectedClients || 0}`,
      [[{ text: '🔄 Обновить', callback_data: 'stats' }]]
    );
    return;
  }

  // /add [telegramId] [amount]
  if (text.startsWith('/add') && isAdmin) {
    const parts = text.split(' ');
    if (parts.length < 3) {
      await sendMessage(chatId, '❌ Формат: /add [telegramId] [количество]');
      return;
    }
    const targetId = parts[1];
    const amount = parseInt(parts[2]);
    if (!amount || amount <= 0) {
      await sendMessage(chatId, '❌ Неверное количество');
      return;
    }
    const result = await localRequest('/add-bids', 'POST', {
      telegramId: targetId, amount, adminKey: ADMIN_KEY
    });
    if (result.success) {
      await sendMessage(chatId, `✅ Зачислено <b>${amount} ставок</b> пользователю ${targetId}\nБаланс: ${result.bids}`);
    } else {
      await sendMessage(chatId, '❌ Ошибка: ' + (result.error || 'неизвестно'));
    }
    return;
  }

  // /users
  if (text === '/users' && isAdmin) {
    const result = await localRequest('/admin/users?adminKey=' + ADMIN_KEY);
    if (!Array.isArray(result) || result.length === 0) {
      await sendMessage(chatId, '👥 Пользователей пока нет');
      return;
    }
    const list = result.slice(0, 20).map(u =>
      `• ${u.name} (${u.id}): ${u.bids} ставок, ${u.wins} побед`
    ).join('\n');
    await sendMessage(chatId, `👥 <b>Пользователи (${result.length}):</b>\n\n${list}`);
    return;
  }

  // Payment request from user (format: PAY:[telegramId]:[name]:[count]:[price])
  if (text.startsWith('PAY:') && isAdmin) {
    // FIX: use regex to safely parse — name might contain spaces but not colons
    const match = text.match(/^PAY:(\d+):([^:]+):(\d+):(\d+)$/);
    if (match) {
      const [, telegramId, name, count, price] = match;
      pendingPayments[telegramId] = { name, packCount: parseInt(count), packPrice: parseInt(price), timestamp: Date.now() };
      await sendMessage(chatId,
        `💳 <b>Новая заявка на ставки</b>\n\n` +
        `👤 Пользователь: ${name} (${telegramId})\n` +
        `🎯 Ставок: ${count}\n` +
        `💰 Сумма: ${parseInt(price).toLocaleString('ru-RU')} сум\n\n` +
        `После получения оплаты нажми ✅`,
        [[
          { text: '✅ Подтвердить', callback_data: 'confirm_' + telegramId },
          { text: '❌ Отклонить', callback_data: 'reject_' + telegramId }
        ]]
      );
    } else {
      await sendMessage(chatId, '❌ Неверный формат заявки');
    }
    return;
  }
}

// Long polling
let lastUpdateId = 0;

async function poll() {
  try {
    const res = await tgRequest('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message', 'callback_query']
    });

    if (res.result && res.result.length > 0) {
      for (const update of res.result) {
        lastUpdateId = update.update_id;
        try { await handleUpdate(update); } catch(e) { console.error('Handle error:', e.message); }
      }
    }
  } catch(e) {
    console.error('Poll error:', e.message);
    await new Promise(r => setTimeout(r, 3000));
  }

  // FIX: use setImmediate to prevent call stack overflow on rapid errors
  setImmediate(poll);
}

// Notify admin function (called from server.js)
async function notifyAdmin(message, keyboard) {
  if (!ADMIN_CHAT_ID || !ADMIN_BOT_TOKEN) return;
  try { await sendMessage(ADMIN_CHAT_ID, message, keyboard); } catch(e) {}
}

module.exports = { poll, notifyAdmin, pendingPayments };

// Start if run directly
if (require.main === module) {
  if (!ADMIN_BOT_TOKEN) { console.error('ADMIN_BOT_TOKEN не задан'); process.exit(1); }
  if (!ADMIN_CHAT_ID) { console.error('ADMIN_CHAT_ID не задан'); process.exit(1); }
  console.log('Admin bot started');
  poll();
}
