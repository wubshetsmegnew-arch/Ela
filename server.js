const express = require('express');
const http = require('http');
const https = require('https');
const dns = require('dns');

const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
const ADMIN_ID = Number(process.env.ADMIN_ID || 7379955498);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@zinabingo';
const CHANNEL_URL = process.env.CHANNEL_URL || 'https://t.me/zinabingo';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://ela-jbix.onrender.com';
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || '@ZinaBingoBot';

const HOUSE_COMMISSION = 0.20;
const LOBBY_SECONDS = 30;
const CALL_INTERVAL_MS = 2500;
const TOTAL_BOARDS = 600;

const DATA_FILE = path.join(__dirname, 'zina_bingo_data.json');

let store = {
  settings: {
    telebirr: '09XXXXXXXX (ስም ያስገቡ)',
    cbe: '1000XXXXXXXXX (ስም ያስገቡ)',
    welcomeBonus: 10,
    minDeposit: 20,
    minWithdraw: 50
  },
  users: {},
  requests: {}
};

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        store.settings = { ...store.settings, ...(raw.settings || {}) };
        store.users = raw.users || {};
        store.requests = raw.requests || {};
      }
    }
  } catch (err) {
    console.error('Failed to load store:', err.message);
  }
}

function saveStore() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('Failed to save store:', err.message);
  }
}

loadStore();

const adminSessions = new Map();

function addHistory(user, entry) {
  if (!Array.isArray(user.history)) user.history = [];
  user.history.unshift({
    ...entry,
    time: new Date().toISOString()
  });
  if (user.history.length > 50) {
    user.history = user.history.slice(0, 50);
  }
}

function getOrCreateUser(userId, info = {}) {
  const key = String(userId);
  if (!store.users[key]) {
    const bonus = Number(store.settings.welcomeBonus) || 0;
    store.users[key] = {
      id: key,
      firstName: info.firstName || 'Player',
      username: info.username || '',
      main: 0,
      bonus,
      dep: 0,
      withd: 0,
      welcomeBonusGiven: bonus > 0,
      history: []
    };
    if (bonus > 0) {
      addHistory(store.users[key], {
        type: 'welcome_bonus',
        amount: bonus,
        note: 'የጀማሪ ቦነስ (Welcome Bonus)'
      });
    }
    saveStore();
  } else {
    if (info.firstName) store.users[key].firstName = info.firstName;
    if (info.username) store.users[key].username = info.username;
    if (!Array.isArray(store.users[key].history)) store.users[key].history = [];
  }
  return store.users[key];
}

function getWallet(key) {
  return getOrCreateUser(key);
}

function getSocketKey(socket) {
  return socket.data.userId || socket.id;
}

function generateRoundCode(roundNumber) {
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${roundNumber}_${suffix}`;
}

function generateBoard(boardId) {
  const ranges = [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75]
  ];
  const grid = Array.from({ length: 5 }, () => Array(5).fill(null));

  for (let col = 0; col < 5; col++) {
    const [min, max] = ranges[col];
    const pool = [];
    for (let n = min; n <= max; n++) pool.push(n);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (let row = 0; row < 5; row++) {
      grid[row][col] = (row === 2 && col === 2) ? 'FREE' : pool[row];
    }
  }

  return { boardId, grid };
}

const boardTemplates = new Map();
for (let i = 1; i <= TOTAL_BOARDS; i++) {
  boardTemplates.set(i, generateBoard(i));
}

let gameState = {
  phase: 'LOBBY',
  countdown: LOBBY_SECONDS,
  stake: 10,
  roundNumber: 1,
  gameId: 1,
  gameCode: generateRoundCode(1),
  takenBoards: new Map(),
  calledNumbers: [],
  availableNumbers: [],
  winners: [],
  prizePool: 0
};

let lobbyTimer = null;
let drawTimer = null;

function mapPhaseForClient(phase) {
  if (phase === 'LOBBY') return 'lobby';
  if (phase === 'PLAYING') return 'play';
  return 'win';
}

function resetPool() {
  const nums = [];
  for (let i = 1; i <= 75; i++) nums.push(i);
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  gameState.availableNumbers = nums;
  gameState.calledNumbers = [];
}

function getBookedMap() {
  const booked = {};
  for (const [boardId, info] of gameState.takenBoards.entries()) {
    booked[boardId] = info.username;
  }
  return booked;
}

function calculatePrizePool() {
  const totalPot = gameState.takenBoards.size * gameState.stake;
  return Number((totalPot * (1 - HOUSE_COMMISSION)).toFixed(2));
}

function getWinningCells(grid, calledSet) {
  const isMarked = (r, c) => {
    const val = grid[r][c];
    return val === 'FREE' || calledSet.has(val);
  };

  for (let r = 0; r < 5; r++) {
    if ([0, 1, 2, 3, 4].every((c) => isMarked(r, c))) {
      return {
        pattern: `Horizontal (Row ${r + 1})`,
        line: { type: 'row', index: r },
        cells: [0, 1, 2, 3, 4].map((c) => [r, c])
      };
    }
  }

  for (let c = 0; c < 5; c++) {
    if ([0, 1, 2, 3, 4].every((r) => isMarked(r, c))) {
      return {
        pattern: `Vertical (Col ${c + 1})`,
        line: { type: 'col', index: c },
        cells: [0, 1, 2, 3, 4].map((r) => [r, c])
      };
    }
  }

  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, i))) {
    return {
      pattern: 'Diagonal (Top-Left to Bottom-Right)',
      line: { type: 'diag', index: 0 },
      cells: [0, 1, 2, 3, 4].map((i) => [i, i])
    };
  }

  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, 4 - i))) {
    return {
      pattern: 'Diagonal (Top-Right to Bottom-Left)',
      line: { type: 'diag', index: 1 },
      cells: [0, 1, 2, 3, 4].map((i) => [i, 4 - i])
    };
  }

  if (isMarked(0, 0) && isMarked(0, 4) && isMarked(4, 0) && isMarked(4, 4)) {
    return {
      pattern: '4-Corners',
      line: { type: 'corners', index: 0 },
      cells: [[0, 0], [0, 4], [4, 0], [4, 4]]
    };
  }

  return null;
}

function emitRoomStateToSocket(socket) {
  const key = getSocketKey(socket);
  const mine = [];
  for (const [boardId, info] of gameState.takenBoards.entries()) {
    if (info.socketId === socket.id) mine.push(boardId);
  }
  const u = getWallet(key);

  socket.emit('room:state', {
    phase: mapPhaseForClient(gameState.phase),
    t: gameState.countdown,
    stake: gameState.stake,
    rn: gameState.roundNumber,
    booked: getBookedMap(),
    mine,
    called: gameState.calledNumbers,
    gid: gameState.gameId,
    gcode: gameState.gameCode,
    pool: calculatePrizePool(),
    players: new Set([...gameState.takenBoards.values()].map((b) => b.socketId)).size,
    wallet: { main: u.main, bonus: u.bonus, dep: u.dep }
  });
}

function evaluateWinners() {
  const calledSet = new Set(gameState.calledNumbers);
  const foundWinners = [];

  for (const [boardId, player] of gameState.takenBoards.entries()) {
    const winInfo = getWinningCells(player.board.grid, calledSet);
    if (winInfo) {
      foundWinners.push({
        socketId: player.socketId,
        userId: player.userId,
        name: player.username,
        board: boardId,
        grid: player.board.grid,
        pattern: winInfo.pattern,
        line: winInfo.line,
        cells: winInfo.cells
      });
    }
  }

  if (foundWinners.length > 0) {
    clearInterval(drawTimer);
    drawTimer = null;
    gameState.phase = 'FINISHED';

    const totalPrize = calculatePrizePool();
    const splitAmount = Number((totalPrize / foundWinners.length).toFixed(2));
    const winSeconds = 8;

    const winnersPayload = foundWinners.map((w) => ({
      board: w.board,
      grid: w.grid,
      name: w.name,
      userId: w.userId,
      pattern: w.pattern,
      line: w.line,
      cells: w.cells,
      prize: splitAmount
    }));

    for (const w of foundWinners) {
      const wKey = String(w.userId || w.socketId);
      const user = getOrCreateUser(wKey, { firstName: w.name });
      user.main = Number((user.main + splitAmount).toFixed(2));
      addHistory(user, {
        type: 'win',
        amount: splitAmount,
        gameCode: gameState.gameCode,
        board: w.board,
        pattern: w.pattern
      });
      io.to(w.socketId).emit('wallet:update', {
        main: user.main,
        bonus: user.bonus,
        dep: user.dep
      });
    }
    saveStore();

    io.emit('game:win', {
      gid: gameState.gameId,
      gcode: gameState.gameCode,
      winners: winnersPayload,
      prize: splitAmount,
      pool: totalPrize,
      called: gameState.calledNumbers,
      t: winSeconds
    });

    setTimeout(() => {
      startLobby();
    }, winSeconds * 1000);
  }
}

function startDrawing() {
  gameState.phase = 'PLAYING';
  gameState.winners = [];
  gameState.prizePool = calculatePrizePool();
  resetPool();

  io.emit('game:start', {
    gid: gameState.gameId,
    gcode: gameState.gameCode,
    pool: gameState.prizePool,
    players: new Set([...gameState.takenBoards.values()].map((b) => b.socketId)).size
  });

  drawTimer = setInterval(() => {
    if (gameState.availableNumbers.length === 0) {
      clearInterval(drawTimer);
      drawTimer = null;
      gameState.phase = 'FINISHED';
      io.emit('game:win', {
        gid: gameState.gameId,
        gcode: gameState.gameCode,
        winners: [],
        prize: 0,
        pool: gameState.prizePool,
        called: gameState.calledNumbers,
        t: 6,
        message: 'All 75 numbers called with no winner.'
      });
      setTimeout(() => startLobby(), 6000);
      return;
    }

    const nextNumber = gameState.availableNumbers.shift();
    gameState.calledNumbers.push(nextNumber);

    io.emit('game:call', {
      n: nextNumber,
      called: gameState.calledNumbers
    });

    evaluateWinners();
  }, CALL_INTERVAL_MS);
}

function startLobby() {
  clearInterval(lobbyTimer);
  clearInterval(drawTimer);
  lobbyTimer = null;
  drawTimer = null;

  gameState.phase = 'LOBBY';
  gameState.countdown = LOBBY_SECONDS;
  gameState.gameId += 1;
  gameState.roundNumber = gameState.gameId;
  gameState.gameCode = generateRoundCode(gameState.gameId);
  gameState.takenBoards.clear();
  gameState.calledNumbers = [];
  gameState.availableNumbers = [];
  gameState.winners = [];
  gameState.prizePool = 0;

  for (const [, sock] of io.sockets.sockets) {
    emitRoomStateToSocket(sock);
  }

  lobbyTimer = setInterval(() => {
    gameState.countdown -= 1;
    io.emit('room:state', {
      phase: 'lobby',
      t: gameState.countdown,
      stake: gameState.stake,
      rn: gameState.roundNumber,
      booked: getBookedMap(),
      called: [],
      gid: gameState.gameId,
      gcode: gameState.gameCode,
      pool: calculatePrizePool(),
      players: new Set([...gameState.takenBoards.values()].map((b) => b.socketId)).size
    });

    if (gameState.countdown <= 0) {
      clearInterval(lobbyTimer);
      lobbyTimer = null;
      startDrawing();
    }
  }, 1000);
}
// --- Telegram Bot (@ZinaBingoBot) + @zinabingo Membership Check ---
function tgApi(method, body = {}, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (!BOT_TOKEN) return resolve(null);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/${method}`,
        method: 'POST',
        port: 443,
        family: 4,
        lookup: (hostname, opts, cb) => dns.lookup(hostname, { family: 4 }, cb),
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', (err) => {
      console.error(`tgApi [${method}] error:`, err.message);
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

async function isChannelMember(userId) {
  if (!BOT_TOKEN || !CHANNEL_USERNAME || !userId) return true;
  try {
    const data = await tgApi('getChatMember', {
      chat_id: CHANNEL_USERNAME,
      user_id: userId
    });
    const status = data?.result?.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch (err) {
    console.error('getChatMember error:', err);
    return false;
  }
}

function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
}

function getMainMenuKeyboard(userId) {
  const rows = [
    [{ text: '🎮 Play Game', web_app: { url: WEBAPP_URL } }],
    [{ text: '💰 Deposit' }, { text: '💸 Withdraw' }],
    [{ text: '💳 Balance' }, { text: '📜 History' }],
    [{ text: '📞 Support' }, { text: '📊 Instructions' }],
    [{ text: '🎁 Invite Friends' }]
  ];
  if (isAdmin(userId)) {
    rows.push([{ text: '🛡️ Admin Panel' }]);
  }
  return {
    keyboard: rows,
    resize_keyboard: true
  };
}

function getAdminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📱 Change Telebirr', callback_data: 'adm_set_telebirr' },
        { text: '🏦 Change CBE', callback_data: 'adm_set_cbe' }
      ],
      [
        { text: '🎁 Change Welcome Bonus', callback_data: 'adm_set_bonus' },
        { text: '➕ Add Balance', callback_data: 'adm_add_balance' }
      ],
      [
        { text: '📊 View Settings', callback_data: 'adm_view_settings' }
      ]
    ]
  };
}

async function sendAdminPanel(chatId) {
  const msg =
    `🛡️ *Zina Bingo Admin Panel*\n\n` +
    `• *Telebirr:* \`${store.settings.telebirr}\`\n` +
    `• *CBE:* \`${store.settings.cbe}\`\n` +
    `• *Welcome Bonus:* *${store.settings.welcomeBonus} ብር*\n` +
    `• *Min Deposit:* *${store.settings.minDeposit} ብር*\n` +
    `• *Min Withdraw:* *${store.settings.minWithdraw} ብር*`;

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: msg,
    parse_mode: 'Markdown',
    reply_markup: getAdminKeyboard()
  });
}

async function sendJoinPrompt(chatId, textPrefix = '') {
  const text =
    `${textPrefix ? textPrefix + '\n\n' : ''}` +
    `📢 *Zina Bingo* ጨዋታን ለመጠቀም እባክዎ መጀመሪያ ይፋዊ ቻናላችንን (*${CHANNEL_USERNAME}*) ይቀላቀሉ።\n` +
    `ከተቀላቀሉ በኋላ *"✅ ተቀላቅያለሁ"* የሚለውን ቁልፍ ይንኩ።`;

  await tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📢 ቻናል ይክፈቱ (Join Channel)', url: CHANNEL_URL }],
        [{ text: '✅ ተቀላቅያለሁ (Verify)', callback_data: 'verify_channel' }]
      ]
    }
  });
}

async function sendMainMenu(chatId, userId, firstName = 'Player') {
  const u = getOrCreateUser(userId, { firstName });
  const bonusLine = u.welcomeBonusGiven
    ? `🎁 የጀማሪ ቦነስ *${store.settings.welcomeBonus} ብር* በBonus Balance ተሰጥቷል።\n`
    : '';
  const text =
    `🎉 *እንኳን ወደ Zina Bingo በደህና መጡ፣ ${firstName}!*\n\n` +
    bonusLine +
    `ከታች ካሉት ቁልፎች አንዱን በመምረጥ ይጀምሩ፦`;

  await tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: getMainMenuKeyboard(userId)
  });
}

function formatHistoryText(user) {
  if (!Array.isArray(user.history) || user.history.length === 0) {
    return '📜 *የእርስዎ ታሪክ (History)*\n\nእስካሁን ምንም የተመዘገበ ታሪክ የለም።';
  }
  const lines = user.history.slice(0, 10).map((h) => {
    const d = h.time ? h.time.slice(0, 16).replace('T', ' ') : '';
    if (h.type === 'welcome_bonus') return `• 🎁 ቦነስ: +${h.amount} ብር (${d})`;
    if (h.type === 'deposit_approved') return `• 💰 Deposit (Approved): +${h.amount} ብር (${d})`;
    if (h.type === 'withdraw_approved') return `• 💸 Withdraw (Approved): -${h.amount} ብር (${d})`;
    if (h.type === 'win') return `• 🏆 ድል (${h.pattern}): +${h.amount} ብር (${d})`;
    if (h.type === 'admin_add') return `• 🛡️ Admin Adjust: ${h.amount >= 0 ? '+' : ''}${h.amount} ብር (${d})`;
    return `• ℹ️ ${h.note || h.type}: ${h.amount ?? ''} (${d})`;
  });
  return `📜 *የእርስዎ የቅርብ ጊዜ ታሪክ (History)*\n\n` + lines.join('\n');
}

async function handleBotMessage(msg) {
  const chatId = msg.chat?.id;
  const user = msg.from;
  const text = (msg.text || '').trim();
  if (!chatId || !user) return;

  const member = await isChannelMember(user.id);
  if (!member) {
    await sendJoinPrompt(chatId);
    return;
  }

  const u = getOrCreateUser(user.id, {
    firstName: user.first_name || 'Player',
    username: user.username || ''
  });

  const session = adminSessions.get(user.id);
  if (session && !text.startsWith('/')) {
    if (session.mode === 'await_deposit_amount') {
      const amt = Number(text);
      if (!Number.isFinite(amt) || amt < Number(store.settings.minDeposit)) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `❌ እባክዎ ትክክለኛ የገንዘብ መጠን (ቢያንስ *${store.settings.minDeposit} ብር*) በቁጥር ያስገቡ።`,
          parse_mode: 'Markdown'
        });
        return;
      }
      const reqId = `DEP_${Date.now()}_${user.id}`;
      store.requests[reqId] = {
        id: reqId,
        type: 'deposit',
        userId: String(user.id),
        userName: user.first_name || 'Player',
        amount: Number(amt.toFixed(2)),
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      saveStore();
      adminSessions.delete(user.id);

      await tgApi('sendMessage', {
        chat_id: chatId,
        text:
          `✅ *የDeposit ጥያቄዎ ተልኳል!*\n\n` +
          `• መለያ: \`${reqId}\`\n` +
          `• መጠን: *${amt.toFixed(2)} ብር*\n` +
          `• ሁኔታ: *Pending (በመጠባበቅ ላይ)*\n\n` +
          `እባክዎ ደረሰኝ (Screenshot/SMS) ካለዎት ለድጋፍ (${SUPPORT_USERNAME}) ይላኩ። አስተዳዳሪው ሲያረጋግጥ ሂሳብዎ ይጨምራል።`,
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(user.id)
      });

      await tgApi('sendMessage', {
        chat_id: ADMIN_ID,
        text:
          `💰 *አዲስ የDeposit ጥያቄ!*\n\n` +
          `• Request ID: \`${reqId}\`\n` +
          `• ተጫዋች: *${user.first_name || 'Player'}* (\`${user.id}\`)\n` +
          `• መጠን: *${amt.toFixed(2)} ብር*\n\n` +
          `በስልክ/ባንክዎ ገንዘቡ መግባቱን ካረጋገጡ በኋላ Approve ያድርጉ፦`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve Deposit', callback_data: `req_app_${reqId}` },
              { text: '❌ Reject', callback_data: `req_rej_${reqId}` }
            ]
          ]
        }
      });
      return;
    }

    if (session.mode === 'await_withdraw_request') {
      const parts = text.split(/\s+/);
      const amt = Number(parts[0]);
      const accountInfo = parts.slice(1).join(' ').trim();

      if (!Number.isFinite(amt) || amt < Number(store.settings.minWithdraw)) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `❌ ዝቅተኛው የማውጫ መጠን *${store.settings.minWithdraw} ብር* ነው። እባክዎ መጠን እና አካውንት ያስገቡ (ለምሳሌ፡ \`100 0911223344\`)።`,
          parse_mode: 'Markdown'
        });
        return;
      }
      if (!accountInfo) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `❌ እባክዎ የገንዘብ መቀበያ ስልክ ቁጥር ወይም አካውንት አብረው ያስገቡ (ለምሳሌ፡ \`100 0911223344\`)።`,
          parse_mode: 'Markdown'
        });
        return;
      }
      if (u.main < amt) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `❌ በቂ *Main Balance* የለዎትም! ያለዎት Main Balance: *${u.main.toFixed(2)} ብር* ነው (Bonus Balance በቀጥታ ወጪ አይሆንም)።`,
          parse_mode: 'Markdown'
        });
        return;
      }

      const reqId = `WDR_${Date.now()}_${user.id}`;
      store.requests[reqId] = {
        id: reqId,
        type: 'withdraw',
        userId: String(user.id),
        userName: user.first_name || 'Player',
        amount: Number(amt.toFixed(2)),
        accountInfo,
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      saveStore();
      adminSessions.delete(user.id);

      await tgApi('sendMessage', {
        chat_id: chatId,
        text:
          `✅ *የWithdraw ጥያቄዎ ተልኳል!*\n\n` +
          `• Request ID: \`${reqId}\`\n` +
          `• መጠን: *${amt.toFixed(2)} ብር*\n` +
          `• አካውንት: \`${accountInfo}\`\n` +
          `• ሁኔታ: *Pending (በመጠባበቅ ላይ)*`,
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(user.id)
      });

      await tgApi('sendMessage', {
        chat_id: ADMIN_ID,
        text:
          `💸 *አዲስ የWithdraw ጥያቄ!*\n\n` +
          `• Request ID: \`${reqId}\`\n` +
          `• ተጫዋች: *${user.first_name || 'Player'}* (\`${user.id}\`)\n` +
          `• Main Balance: *${u.main.toFixed(2)} ብር*\n` +
          `• የሚወጣ መጠን: *${amt.toFixed(2)} ብር*\n` +
          `• መቀበያ አካውንት: \`${accountInfo}\`\n\n` +
          `ገንዘቡን ከላኩ በኋላ Approve ሲያደርጉ ከሂሳቡ ይቀነሳል፦`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve Withdraw', callback_data: `req_app_${reqId}` },
              { text: '❌ Reject', callback_data: `req_rej_${reqId}` }
            ]
          ]
        }
      });
      return;
    }

    if (isAdmin(user.id)) {
      if (session.mode === 'set_telebirr') {
        store.settings.telebirr = text;
        saveStore();
        adminSessions.delete(user.id);
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `✅ Telebirr አካውንት ተቀይሯል፦ \`${text}\``,
          parse_mode: 'Markdown'
        });
        await sendAdminPanel(chatId);
        return;
      }

      if (session.mode === 'set_cbe') {
        store.settings.cbe = text;
        saveStore();
        adminSessions.delete(user.id);
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `✅ CBE አካውንት ተቀይሯል፦ \`${text}\``,
          parse_mode: 'Markdown'
        });
        await sendAdminPanel(chatId);
        return;
      }

      if (session.mode === 'set_bonus') {
        const bonusVal = Number(text);
        if (!Number.isFinite(bonusVal) || bonusVal < 0) {
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: '❌ እባክዎ ትክክለኛ ቁጥር ያስገቡ (ለምሳሌ፡ `10`)።',
            parse_mode: 'Markdown'
          });
          return;
        }
        store.settings.welcomeBonus = bonusVal;
        saveStore();
        adminSessions.delete(user.id);
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `✅ የጀማሪ ቦነስ ወደ *${bonusVal} ብር* ተቀይሯል።`,
          parse_mode: 'Markdown'
        });
        await sendAdminPanel(chatId);
        return;
      }

      if (session.mode === 'add_balance') {
        const parts = text.split(/\s+/);
        const targetId = String(parts[0] || '').trim();
        const delta = Number(parts[1]);

        if (!targetId || !Number.isFinite(delta)) {
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: '❌ ቅርጸት፡ `<UserID> <Amount>` (ለምሳሌ፡ `123456789 50` ወይም `123456789 -20`)።',
            parse_mode: 'Markdown'
          });
          return;
        }

        const targetUser = getOrCreateUser(targetId);
        const nextMain = Number((targetUser.main + delta).toFixed(2));
        if (nextMain < 0) {
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: `❌ ከዜሮ በታች ሊሆን አይችልም! የተጫዋቹ Main Balance: *${targetUser.main.toFixed(2)} ብር* ነው።`,
            parse_mode: 'Markdown'
          });
          return;
        }

        targetUser.main = nextMain;
        addHistory(targetUser, {
          type: 'admin_add',
          amount: delta,
          note: 'Admin balance adjustment'
        });
        saveStore();
        adminSessions.delete(user.id);

        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `✅ የተጠቃሚ \`${targetId}\` አዲስ Main Balance: *${targetUser.main.toFixed(2)} ብር*።`,
          parse_mode: 'Markdown'
        });

        await tgApi('sendMessage', {
          chat_id: targetId,
          text: `ℹ️ በአስተዳዳሪ በኩል በሂሳብዎ ላይ *${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ብር* ለውጥ ተደርጓል። አዲስ Main Balance: *${targetUser.main.toFixed(2)} ብር*።`,
          parse_mode: 'Markdown'
        });
        await sendAdminPanel(chatId);
        return;
      }
    }
  }

  if (text === '/start' || text.startsWith('/start ')) {
    await sendMainMenu(chatId, user.id, user.first_name || 'Player');
    return;
  }

  if (text === '/admin' || text === '🛡️ Admin Panel') {
    if (!isAdmin(user.id)) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '⛔ ይህ ክፍል ለአስተዳዳሪ (Admin) ብቻ ነው።'
      });
      return;
    }
    await sendAdminPanel(chatId);
    return;
  }

  if (text === '💳 Balance') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `💳 *የZina Bingo ቀሪ ሂሳብዎ*\n\n` +
        `🆔 ID: \`${user.id}\`\n` +
        `💰 Main Balance: *${u.main.toFixed(2)} ብር*\n` +
        `🎁 Bonus: *${u.bonus.toFixed(2)} ብር*`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard(user.id)
    });
    return;
  }

  if (text === '📜 History') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: formatHistoryText(u),
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard(user.id)
    });
    return;
  }

  if (text === '💰 Deposit') {
    adminSessions.set(user.id, { mode: 'await_deposit_amount' });
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `💰 *ገንዘብ ማስገቢያ (Deposit) — Zina Bingo*\n\n` +
        `• *Telebirr:* \`${store.settings.telebirr}\`\n` +
        `• *CBE:* \`${store.settings.cbe}\`\n` +
        `• *ዝቅተኛ መጠን:* *${store.settings.minDeposit} ብር*\n\n` +
        `ገንዘብ ከላኩ በኋላ ያስገቡትን የብር መጠን በቁጥር ይጻፉ (ለምሳሌ፡ \`50\`)፦`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard(user.id)
    });
    return;
  }

  if (text === '💸 Withdraw') {
    adminSessions.set(user.id, { mode: 'await_withdraw_request' });
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `💸 *ገንዘብ ማውጫ (Withdraw) — Zina Bingo*\n\n` +
        `• *Main Balance:* *${u.main.toFixed(2)} ብር*\n` +
        `• *Bonus Balance:* *${u.bonus.toFixed(2)} ብር* (በቀጥታ ወጪ አይሆንም)\n` +
        `• *ዝቅተኛ ማውጫ:* *${store.settings.minWithdraw} ብር*\n\n` +
        `የሚያወጡትን መጠን እና የመቀበያ ስልክ/አካውንት በአንድ መስመር ይጻፉ\n` +
        `ምሳሌ፦ \`100 0911223344\``,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard(user.id)
    });
    return;
  }

  if (text === '📞 Support') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `📞 *Zina Bingo Support*\n\n` +
        `🆔 የእርስዎ ID: \`${user.id}\`\n` +
        `ለማንኛውም ጥያቄ ወይም ደረሰኝ ለመላክ፦ ${SUPPORT_USERNAME}`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard(user.id)
    });
    return;
  }

  if (text === '📊 Instructions') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `📊 *የZina Bingo አጫዋወት መመሪያ*\n\n` +
        `1️⃣ *Play Game* ን በመንካት ጨዋታውን ይክፈቱ።\n` +
        `2️⃣ ከሚገኙት ካርቴላዎች (እስከ 2 ካርቴላ) ይምረጡ።\n` +
        `3️⃣ ቁጥሮች ሲጠሩ መስመር ወይም የካርዱን 4 የጫፍ ማዕዘኖች ሲሞሉ *BINGO* ያሸንፋሉ።`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard(user.id)
    });
    return;
  }

  if (text === '🎁 Invite Friends') {
    const inviteLink = `https://t.me/ZinaBingoBot?start=ref_${user.id}`;
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `🎁 *ጓደኞችዎን ይጋብዙ (Zina Bingo)*\n\nየመጋበዣ ሊንክዎ፦\n${inviteLink}`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard(user.id)
    });
    return;
  }

  await sendMainMenu(chatId, user.id, user.first_name || 'Player');
}

async function handleBotCallback(cb) {
  const user = cb.from;
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  if (!user || !chatId) return;

  if (data === 'verify_channel') {
    const member = await isChannelMember(user.id);
    if (member) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '✅ ቻናሉን ተቀላቅለዋል! እንኳን ደህና መጡ።'
      });
      await sendMainMenu(chatId, user.id, user.first_name || 'Player');
    } else {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '❌ አሁንም ቻናሉን አልተቀላቀሉም። እባክዎ መጀመሪያ ይቀላቀሉ።',
        show_alert: true
      });
      await sendJoinPrompt(chatId);
    }
    return;
  }

  if (data.startsWith('adm_')) {
    if (!isAdmin(user.id)) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '⛔ Admin ብቻ ነው።',
        show_alert: true
      });
      return;
    }

    if (data === 'adm_set_telebirr') {
      adminSessions.set(user.id, { mode: 'set_telebirr' });
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '📱 አዲሱን የTelebirr ቁጥር እና ስም ይጻፉ (ለምሳሌ፡ `0911000000 - Zina Bingo`)፦',
        parse_mode: 'Markdown'
      });
      return;
    }

    if (data === 'adm_set_cbe') {
      adminSessions.set(user.id, { mode: 'set_cbe' });
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '🏦 አዲሱን የCBE አካውንት ቁጥር እና ስም ይጻፉ (ለምሳሌ፡ `1000123456789 - Zina Bingo`)፦',
        parse_mode: 'Markdown'
      });
      return;
    }

    if (data === 'adm_set_bonus') {
      adminSessions.set(user.id, { mode: 'set_bonus' });
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '🎁 ለአዲስ ጀማሪ የሚሰጠውን የቦነስ መጠን በቁጥር ይጻፉ (ለምሳሌ፡ `10`)፦',
        parse_mode: 'Markdown'
      });
      return;
    }

    if (data === 'adm_add_balance') {
      adminSessions.set(user.id, { mode: 'add_balance' });
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '➕ የተጫዋቹን User ID እና ብር መጠን ይጻፉ\nምሳሌ፦ `123456789 50` (ወይም ለመቀነስ `123456789 -20`)፦',
        parse_mode: 'Markdown'
      });
      return;
    }

    if (data === 'adm_view_settings') {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      await sendAdminPanel(chatId);
      return;
    }
  }

  if (data.startsWith('req_app_') || data.startsWith('req_rej_')) {
    if (!isAdmin(user.id)) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '⛔ Admin ብቻ ነው።',
        show_alert: true
      });
      return;
    }

    const isApprove = data.startsWith('req_app_');
    const reqId = data.replace(/^req_(app|rej)_/, '');
    const reqObj = store.requests[reqId];

    if (!reqObj) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '⚠️ ጥያቄው አልተገኘም።',
        show_alert: true
      });
      return;
    }

    if (reqObj.status !== 'pending') {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: `⚠️ ይህ ጥያቄ ቀድሞውኑ ${reqObj.status.toUpperCase()} ተደርጓል።`,
        show_alert: true
      });
      return;
    }

    const targetUser = getOrCreateUser(reqObj.userId, { firstName: reqObj.userName });

    if (!isApprove) {
      reqObj.status = 'rejected';
      addHistory(targetUser, {
        type: `${reqObj.type}_rejected`,
        amount: reqObj.amount,
        note: `${reqObj.type} rejected`
      });
      saveStore();
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ ተቀባይነት አላገኘም (Rejected)' });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `❌ ጥያቄ \`${reqId}\` Rejected ተደርጓል።`,
        parse_mode: 'Markdown'
      });
      await tgApi('sendMessage', {
        chat_id: reqObj.userId,
        text: `❌ የእርስዎ የ *${reqObj.type.toUpperCase()}* (\`${reqId}\`፣ *${reqObj.amount} ብር*) ጥያቄ ተቀባይነት አላገኘም። ዝርዝር ካስፈለገዎት ${SUPPORT_USERNAME} ያነጋግሩ።`,
        parse_mode: 'Markdown'
      });
      return;
    }

    if (reqObj.type === 'deposit') {
      targetUser.main = Number((targetUser.main + reqObj.amount).toFixed(2));
      targetUser.dep = Number((targetUser.dep + reqObj.amount).toFixed(2));
      reqObj.status = 'approved';
      addHistory(targetUser, {
        type: 'deposit_approved',
        amount: reqObj.amount,
        reqId
      });
      saveStore();

      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ Deposit Approved!' });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ Deposit \`${reqId}\` (*${reqObj.amount} ብር*) Approved ተደርጓል። የተጫዋቹ አዲስ Main Balance: *${targetUser.main.toFixed(2)} ብር*።`,
        parse_mode: 'Markdown'
      });
      await tgApi('sendMessage', {
        chat_id: reqObj.userId,
        text: `✅ *ገንዘብዎ ገብቷል!* *${reqObj.amount.toFixed(2)} ብር* በMain Balance ላይ ተጨምሯል።\n💳 አዲስ Main Balance: *${targetUser.main.toFixed(2)} ብር*`,
        parse_mode: 'Markdown'
      });
    } else if (reqObj.type === 'withdraw') {
      if (targetUser.main < reqObj.amount) {
        await tgApi('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: '❌ በቂ Main Balance የለውም!',
          show_alert: true
        });
        return;
      }
      targetUser.main = Number((targetUser.main - reqObj.amount).toFixed(2));
      targetUser.withd = Number((targetUser.withd + reqObj.amount).toFixed(2));
      reqObj.status = 'approved';
      addHistory(targetUser, {
        type: 'withdraw_approved',
        amount: reqObj.amount,
        reqId,
        accountInfo: reqObj.accountInfo
      });
      saveStore();

      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ Withdraw Approved!' });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ Withdraw \`${reqId}\` (*${reqObj.amount} ብር*) Approved ተደርጓል እና ከሂሳቡ ተቀንሷል። ቀሪ Main Balance: *${targetUser.main.toFixed(2)} ብር*።`,
        parse_mode: 'Markdown'
      });
      await tgApi('sendMessage', {
        chat_id: reqObj.userId,
        text: `✅ የ *${reqObj.amount.toFixed(2)} ብር* Withdraw ጥያቄዎ ተፈጽሟል።\n💳 ቀሪ Main Balance: *${targetUser.main.toFixed(2)} ብር*`,
        parse_mode: 'Markdown'
      });
    }
  }
}

async function startBotPolling() {
  if (!BOT_TOKEN) {
    console.warn('BOT_TOKEN is not set; Telegram bot polling skipped.');
    return;
  }

  await tgApi('deleteWebhook', { drop_pending_updates: false });
  console.log('Telegram bot polling started (IPv4).');

  let offset = 0;
  while (true) {
    try {
      const data = await tgApi('getUpdates', { timeout: 20, offset }, 30000);
      if (data?.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleBotMessage(update.message);
          } else if (update.callback_query) {
            await handleBotCallback(update.callback_query);
          }
        }
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error('Telegram polling error:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    service: '75-Ball Bingo Multiplayer Backend',
    phase: gameState.phase,
    countdown: gameState.countdown,
    gameId: gameState.gameId,
    gameCode: gameState.gameCode,
    takenBoardsCount: gameState.takenBoards.size,
    totalBoards: TOTAL_BOARDS
  });
});

io.on('connection', (socket) => {
  socket.on('room:join', (payload = {}) => {
    if (payload.stake) {
      gameState.stake = Number(payload.stake) || gameState.stake;
    }
    if (payload.user) {
      socket.data.userId = payload.user.id ? String(payload.user.id) : socket.id;
      socket.data.username = payload.user.name || 'Player';
    }
    emitRoomStateToSocket(socket);
  });

  socket.on('room:leave', () => {
    let changed = false;
    for (const [boardId, info] of gameState.takenBoards.entries()) {
      if (info.socketId === socket.id && gameState.phase === 'LOBBY') {
        gameState.takenBoards.delete(boardId);
        io.emit('board:released', { board: boardId });
        changed = true;
      }
    }
    if (changed) {
      io.emit('room:state', {
        phase: mapPhaseForClient(gameState.phase),
        t: gameState.countdown,
        stake: gameState.stake,
        rn: gameState.roundNumber,
        booked: getBookedMap(),
        called: gameState.calledNumbers,
        gid: gameState.gameId,
        gcode: gameState.gameCode,
        pool: calculatePrizePool(),
        players: new Set([...gameState.takenBoards.values()].map((b) => b.socketId)).size
      });
    }
  });

  socket.on('board:pick', ({ board } = {}) => {
    const boardId = Number(board);
    const username = socket.data.username || 'Player';
    const userId = socket.data.userId || socket.id;

    if (gameState.phase !== 'LOBBY') {
      socket.emit('board:rejected', { board: boardId, reason: 'in_progress' });
      return;
    }

    const myBoardsCount = [...gameState.takenBoards.values()].filter(
      (b) => b.socketId === socket.id
    ).length;

    if (myBoardsCount >= 2) {
      socket.emit('board:rejected', { board: boardId, reason: 'max_boards' });
      return;
    }

    if (!boardTemplates.has(boardId) || gameState.takenBoards.has(boardId)) {
      socket.emit('board:rejected', { board: boardId, reason: 'taken' });
      return;
    }

    gameState.takenBoards.set(boardId, {
      boardId,
      socketId: socket.id,
      userId,
      username
    });

    io.emit('board:taken', {
      board: boardId,
      userId,
      username,
      booked: getBookedMap()
    });

    socket.emit('board:picked', {
      board: boardId,
      grid: boardTemplates.get(boardId)
    });
  });

  socket.on('board:unpick', ({ board } = {}) => {
    const boardId = Number(board);
    if (gameState.phase !== 'LOBBY') return;

    const entry = gameState.takenBoards.get(boardId);
    if (entry && entry.socketId === socket.id) {
      gameState.takenBoards.delete(boardId);
      io.emit('board:released', {
        board: boardId,
        booked: getBookedMap()
      });
    }
  });

  socket.on('disconnect', () => {
    let changed = false;
    for (const [boardId, entry] of gameState.takenBoards.entries()) {
      if (entry.socketId === socket.id) {
        gameState.takenBoards.delete(boardId);
        changed = true;
      }
    }
    if (changed && gameState.phase === 'LOBBY') {
      io.emit('state:sync', {
        phase: gameState.phase,
        countdown: gameState.countdown,
        round: gameState.roundNumber,
        booked: getBookedMap(),
        called: gameState.calledNumbers,
        gid: gameState.gameId,
        gcode: gameState.gameCode,
        pool: calculatePrizePool(),
        players: new Set([...gameState.takenBoards.values()].map((b) => b.socketId)).size
      });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Bingo server running on port ${PORT}`);
  startLobby();
  startBotPolling();
});
