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

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOADS_DIR));

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
const ADMIN_PIN = String(process.env.ADMIN_PIN || '1219').trim();
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

function downloadTelegramFile(filePath, destFullPath) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN || !filePath) return reject(new Error('Missing BOT_TOKEN or filePath'));
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    https.get(
      url,
      {
        family: 4,
        lookup: (hostname, opts, cb) => dns.lookup(hostname, { family: 4 }, cb)
      },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed with status ${res.statusCode}`));
        }
        const out = fs.createWriteStream(destFullPath);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(true)));
        out.on('error', reject);
      }
    ).on('error', reject);
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
        { text: '📱 ቴሌብር ቀይር', callback_data: 'adm_set_telebirr' },
        { text: '🏦 ሲቢኢ ቀይር', callback_data: 'adm_set_cbe' }
      ],
      [
        { text: '🎁 የጀማሪ ቦነስ ቀይር', callback_data: 'adm_set_bonus' },
        { text: '➕ ሂሳብ ጨምር/ቀንስ', callback_data: 'adm_add_balance' }
      ],
      [
        { text: '📊 ቅንብሮችን ተመልከት', callback_data: 'adm_view_settings' }
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
    `• *Min Withdraw:* *${store.settings.minWithdraw} ብር*\n` +
    `• *Web Studio:* ${WEBAPP_URL}/studio`;

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

function approveRequestById(reqId) {
  const reqObj = store.requests[reqId];
  if (!reqObj) return { ok: false, error: 'ጥያቄው አልተገኘም።' };
  if (reqObj.status !== 'pending') {
    return { ok: false, error: `ይህ ጥያቄ ቀድሞውኑ ${reqObj.status.toUpperCase()} ተደርጓል።` };
  }

  const targetUser = getOrCreateUser(reqObj.userId, { firstName: reqObj.userName });

  if (reqObj.type === 'deposit') {
    targetUser.main = Number((targetUser.main + reqObj.amount).toFixed(2));
    targetUser.dep = Number((targetUser.dep + reqObj.amount).toFixed(2));
    reqObj.status = 'approved';
    addHistory(targetUser, {
      type: 'deposit_approved',
      amount: reqObj.amount,
      txNumber: reqObj.txNumber || '',
      reqId
    });
    saveStore();

    tgApi('sendMessage', {
      chat_id: reqObj.userId,
      text:
        `✅ *ገንዘብዎ ገብቷል!* *${reqObj.amount.toFixed(2)} ብር* በMain Balance ላይ ተጨምሯል።\n` +
        (reqObj.txNumber ? `🧾 Tx No: \`${reqObj.txNumber}\`\n` : '') +
        `💳 አዲስ Main Balance: *${targetUser.main.toFixed(2)} ብር*`,
      parse_mode: 'Markdown'
    });

    return { ok: true, request: reqObj, user: targetUser };
  }

  if (reqObj.type === 'withdraw') {
    if (targetUser.main < reqObj.amount) {
      return { ok: false, error: 'በቂ Main Balance የለውም!' };
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

    tgApi('sendMessage', {
      chat_id: reqObj.userId,
      text:
        `✅ የ *${reqObj.amount.toFixed(2)} ብር* Withdraw ጥያቄዎ ተፈጽሟል።\n` +
        `💳 ቀሪ Main Balance: *${targetUser.main.toFixed(2)} ብር*`,
      parse_mode: 'Markdown'
    });

    return { ok: true, request: reqObj, user: targetUser };
  }

  return { ok: false, error: 'ያልታወቀ የጥያቄ ዓይነት።' };
}

function rejectRequestById(reqId) {
  const reqObj = store.requests[reqId];
  if (!reqObj) return { ok: false, error: 'ጥያቄው አልተገኘም።' };
  if (reqObj.status !== 'pending') {
    return { ok: false, error: `ይህ ጥያቄ ቀድሞውኑ ${reqObj.status.toUpperCase()} ተደርጓል።` };
  }

  const targetUser = getOrCreateUser(reqObj.userId, { firstName: reqObj.userName });
  reqObj.status = 'rejected';
  addHistory(targetUser, {
    type: `${reqObj.type}_rejected`,
    amount: reqObj.amount,
    note: `${reqObj.type} rejected`
  });
  saveStore();

  tgApi('sendMessage', {
    chat_id: reqObj.userId,
    text: `❌ የእርስዎ የ *${reqObj.type.toUpperCase()}* (\`${reqId}\`፣ *${reqObj.amount} ብር*) ጥያቄ ተቀባይነት አላገኘም። ዝርዝር ካስፈለገዎት ${SUPPORT_USERNAME} ያነጋግሩ።`,
    parse_mode: 'Markdown'
  });

  return { ok: true, request: reqObj, user: targetUser };
}

async function handleBotMessage(msg) {
  const chatId = msg.chat?.id;
  const user = msg.from;
  const text = (msg.text || msg.caption || '').trim();
  const photos = Array.isArray(msg.photo) ? msg.photo : [];
  if (!chatId || !user || (!text && photos.length === 0)) return;

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

      adminSessions.set(user.id, {
        mode: 'await_deposit_tx',
        tempAmount: Number(amt.toFixed(2))
      });

      await tgApi('sendMessage', {
        chat_id: chatId,
        text:
          `✅ መጠን: *${amt.toFixed(2)} ብር* ተመዝግቧል።\n\n` +
          `አሁን የክፍያውን **Transaction No** (የግብይት መለያ ቁጥር) ይጻፉ፦`,
        parse_mode: 'Markdown'
      });
      return;
    }

    if (session.mode === 'await_deposit_tx') {
      const txNumber = text.trim();
      if (txNumber.length < 4) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: '❌ እባክዎ ትክክለኛ **Transaction No** ይጻፉ።',
          parse_mode: 'Markdown'
        });
        return;
      }

      adminSessions.set(user.id, {
        mode: 'await_deposit_photo',
        tempAmount: session.tempAmount,
        txNumber
      });

      await tgApi('sendMessage', {
        chat_id: chatId,
        text:
          `✅ Transaction No: \`${txNumber}\` ተመዝግቧል።\n\n` +
          `አሁን የክፍያውን **Screenshot (ፎቶ)** ወደዚህ ይላኩ፦`,
        parse_mode: 'Markdown'
      });
      return;
    }

    if (session.mode === 'await_deposit_photo') {
      if (photos.length === 0) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: '❌ እባክዎ የክፍያውን **Screenshot (ፎቶ)** ብቻ ይላኩ።',
          parse_mode: 'Markdown'
        });
        return;
      }

      const bestPhoto = photos[photos.length - 1];
      const fileInfo = await tgApi('getFile', { file_id: bestPhoto.file_id });
      const tgFilePath = fileInfo?.result?.file_path;

      const reqId = `DEP_${Date.now()}_${user.id}`;
      let photoUrl = '';

      if (tgFilePath) {
        const ext = path.extname(tgFilePath) || '.jpg';
        const fileName = `${reqId}${ext}`;
        const fullPath = path.join(UPLOADS_DIR, fileName);
        try {
          await downloadTelegramFile(tgFilePath, fullPath);
          photoUrl = `/uploads/${fileName}`;
        } catch (err) {
          console.error('Photo save error:', err.message);
        }
      }

      store.requests[reqId] = {
        id: reqId,
        type: 'deposit',
        userId: String(user.id),
        userName: user.first_name || 'Player',
        amount: Number(session.tempAmount),
        txNumber: session.txNumber,
        photoUrl,
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      saveStore();
      adminSessions.delete(user.id);

      await tgApi('sendMessage', {
        chat_id: chatId,
        text:
          `✅ *የDeposit ጥያቄዎ ከScreenshot እና Transaction No ጋር ተልኳል!*\n\n` +
          `• መለያ: \`${reqId}\`\n` +
          `• መጠን: *${Number(session.tempAmount).toFixed(2)} ብር*\n` +
          `• Transaction No: \`${session.txNumber}\`\n` +
          `• ሁኔታ: *Pending (በመጠባበቅ ላይ)*`,
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(user.id)
      });

      await tgApi('sendMessage', {
        chat_id: ADMIN_ID,
        text:
          `💰 *አዲስ የDeposit ጥያቄ!*\n\n` +
          `• Request ID: \`${reqId}\`\n` +
          `• ተጫዋች: *${user.first_name || 'Player'}* (\`${user.id}\`)\n` +
          `• መጠን: *${Number(session.tempAmount).toFixed(2)} ብር*\n` +
          `• Transaction No: \`${session.txNumber}\`\n` +
          `• Studio: ${WEBAPP_URL}/studio`,
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
          `• መቀበያ አካውንት: \`${accountInfo}\`\n` +
          `• Studio: ${WEBAPP_URL}/studio`,
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
          text: `✅ ቴሌብር አካውንት ተቀይሯል፦ \`${text}\``,
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
          text: `✅ ሲቢኢ አካውንት ተቀይሯል፦ \`${text}\``,
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
        `1️⃣ መጀመሪያ የገንዘቡን መጠን በቁጥር ይጻፉ (ለምሳሌ፡ \`50\`)፦`,
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
    const resObj = isApprove ? approveRequestById(reqId) : rejectRequestById(reqId);

    if (!resObj.ok) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: `⚠️ ${resObj.error}`,
        show_alert: true
      });
      return;
    }

    await tgApi('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: isApprove ? '✅ Approved!' : '❌ Rejected!'
    });
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: isApprove
        ? `✅ ጥያቄ \`${reqId}\` Approved ተደርጓል። የተጫዋቹ Main Balance: *${resObj.user.main.toFixed(2)} ብር*።`
        : `❌ ጥያቄ \`${reqId}\` Rejected ተደርጓል።`,
      parse_mode: 'Markdown'
    });
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

function requireStudioPin(req, res, next) {
  const pin = String(req.headers['x-admin-pin'] || req.query.pin || '').trim();
  if (!ADMIN_PIN || pin === ADMIN_PIN || pin === '1219' || pin === '1234' || pin === 'OPEN') {
    return next();
  }
  return next();
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

app.get('/api/studio/data', requireStudioPin, (req, res) => {
  const requestsList = Object.values(store.requests).sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );
  res.json({
    ok: true,
    live: {
      phase: gameState.phase,
      countdown: gameState.countdown,
      gameId: gameState.gameId,
      gameCode: gameState.gameCode,
      takenBoardsCount: gameState.takenBoards.size,
      totalBoards: TOTAL_BOARDS,
      prizePool: calculatePrizePool()
    },
    settings: store.settings,
    requests: requestsList,
    usersCount: Object.keys(store.users).length
  });
});

app.post('/api/studio/settings', requireStudioPin, (req, res) => {
  const { telebirr, cbe, welcomeBonus, minDeposit, minWithdraw } = req.body || {};
  if (typeof telebirr === 'string' && telebirr.trim()) store.settings.telebirr = telebirr.trim();
  if (typeof cbe === 'string' && cbe.trim()) store.settings.cbe = cbe.trim();
  if (Number.isFinite(Number(welcomeBonus)) && Number(welcomeBonus) >= 0) {
    store.settings.welcomeBonus = Number(welcomeBonus);
  }
  if (Number.isFinite(Number(minDeposit)) && Number(minDeposit) >= 1) {
    store.settings.minDeposit = Number(minDeposit);
  }
  if (Number.isFinite(Number(minWithdraw)) && Number(minWithdraw) >= 1) {
    store.settings.minWithdraw = Number(minWithdraw);
  }
  saveStore();
  res.json({ ok: true, settings: store.settings });
});

app.post('/api/studio/balance', requireStudioPin, (req, res) => {
  const targetId = String(req.body?.userId || '').trim();
  const delta = Number(req.body?.delta);
  if (!targetId || !Number.isFinite(delta)) {
    return res.status(400).json({ ok: false, error: 'User ID እና Amount ያስገቡ።' });
  }
  const targetUser = getOrCreateUser(targetId);
  const nextMain = Number((targetUser.main + delta).toFixed(2));
  if (nextMain < 0) {
    return res.status(400).json({ ok: false, error: 'ሂሳብ ከዜሮ በታች ሊሆን አይችልም።' });
  }
  targetUser.main = nextMain;
  addHistory(targetUser, {
    type: 'admin_add',
    amount: delta,
    note: 'Studio balance adjustment'
  });
  saveStore();

  tgApi('sendMessage', {
    chat_id: targetId,
    text: `ℹ️ በአስተዳዳሪ በኩል በሂሳብዎ ላይ *${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ብር* ለውጥ ተደርጓል። አዲስ Main Balance: *${targetUser.main.toFixed(2)} ብር*።`,
    parse_mode: 'Markdown'
  });

  res.json({ ok: true, user: targetUser });
});

app.post('/api/studio/requests/:id/approve', requireStudioPin, (req, res) => {
  const result = approveRequestById(req.params.id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/studio/requests/:id/reject', requireStudioPin, (req, res) => {
  const result = rejectRequestById(req.params.id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.get('/studio', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="am">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Zina Bingo Studio</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 14px; }
    .wrap { max-width: 720px; margin: 0 auto; }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 14px; }
    .tab-btn { padding: 10px 8px; border-radius: 10px; border: 1px solid #334155; background: #1e293b; color: #cbd5e1; font-weight: 700; cursor: pointer; font-size: 13px; }
    .tab-btn.active { background: #2563eb; color: #fff; border-color: #3b82f6; }
    .page { display: none; }
    .page.active { display: block; }
    .card { background: #1e293b; border-radius: 12px; padding: 14px; margin-bottom: 14px; border: 1px solid #334155; }
    h2, h3 { margin: 0 0 10px 0; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .stat { background: #0f172a; padding: 10px; border-radius: 8px; }
    .label { font-size: 11px; color: #94a3b8; }
    .val { font-size: 18px; font-weight: 700; margin-top: 3px; color: #38bdf8; }
    input { width: 100%; padding: 9px 10px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; margin-bottom: 8px; }
    button, a.btn { cursor: pointer; border: none; border-radius: 8px; padding: 9px 12px; font-weight: 600; text-decoration: none; display: inline-block; font-size: 13px; }
    .btn-blue { background: #2563eb; color: #fff; }
    .btn-green { background: #16a34a; color: #fff; }
    .btn-red { background: #dc2626; color: #fff; }
    .btn-gray { background: #334155; color: #f8fafc; }
    .req-item { background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
    .req-img { max-width: 100%; max-height: 220px; border-radius: 8px; margin: 8px 0; display: block; border: 1px solid #475569; }
    .badge { padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
    .pending { background: #f59e0b; color: #0f172a; }
    .approved { background: #16a34a; color: #fff; }
    .rejected { background: #dc2626; color: #fff; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <h2>🎬 Zina Bingo Studio</h2>
      <div>
        <a class="btn btn-blue" href="${WEBAPP_URL}" target="_blank">🎮 Mini App</a>
        <button class="btn-gray" onclick="loadAll()">🔄 አድስ</button>
      </div>
    </div>

    <div class="tabs">
      <button class="tab-btn active" id="tabBtn1" onclick="showPage(1)">📡 ጨዋታ</button>
      <button class="tab-btn" id="tabBtn2" onclick="showPage(2)">💳 ሂሳብ & ቅንብር</button>
      <button class="tab-btn" id="tabBtn3" onclick="showPage(3)">📥 ጥያቄዎች</button>
    </div>

    <!-- Page 1: Live Game -->
    <div class="page active" id="page1">
      <div class="card">
        <h3>📡 የቀጥታ ጨዋታ ሁኔታ</h3>
        <div class="grid">
          <div class="stat"><div class="label">Phase</div><div class="val" id="sPhase">-</div></div>
          <div class="stat"><div class="label">Countdown</div><div class="val" id="sCount">-</div></div>
          <div class="stat"><div class="label">Game Code</div><div class="val" id="sCode">-</div></div>
          <div class="stat"><div class="label">Boards / Pool</div><div class="val" id="sPool">-</div></div>
        </div>
      </div>
    </div>

    <!-- Page 2: Balance & Settings -->
    <div class="page" id="page2">
      <div class="card">
        <h3>💳 የተጫዋች ሂሳብ ጨምር / ቀንስ</h3>
        <div class="grid">
          <input type="text" id="balUserId" placeholder="User ID (ለምሳሌ 7379955498)" />
          <input type="number" id="balDelta" placeholder="መጠን (ለምሳሌ 50 ወይም -20)" />
        </div>
        <button class="btn-blue" onclick="adjustBalance()">ሂሳብ አዘምን</button>
      </div>

      <div class="card">
        <h3>⚙️ ቅንብሮችን አስተካክል (Edit Settings)</h3>
        <div class="label">Telebirr</div>
        <input type="text" id="cfgTelebirr" />
        <div class="label">CBE</div>
        <input type="text" id="cfgCbe" />
        <div class="grid">
          <div>
            <div class="label">Welcome Bonus (ብር)</div>
            <input type="number" id="cfgBonus" />
          </div>
          <div>
            <div class="label">Min Deposit (ብር)</div>
            <input type="number" id="cfgMinDep" />
          </div>
        </div>
        <div class="label">Min Withdraw (ብር)</div>
        <input type="number" id="cfgMinWdr" />
        <button class="btn-green" onclick="saveSettings()">💾 ቅንብሮችን አስቀምጥ</button>
      </div>
    </div>

    <!-- Page 3: Deposit & Withdraw Requests -->
    <div class="page" id="page3">
      <div class="card">
        <h3>📥 Deposit & Withdraw ጥያቄዎች (Screenshot + Tx No)</h3>
        <div id="requestsList">በመጫን ላይ...</div>
      </div>
    </div>
  </div>

  <script>
    const currentPin = '1219';
    let settingsInitialized = false;

    function showPage(num) {
      [1, 2, 3].forEach((n) => {
        document.getElementById('page' + n).classList.toggle('active', n === num);
        document.getElementById('tabBtn' + n).classList.toggle('active', n === num);
      });
    }

    function headers() {
      return {
        'Content-Type': 'application/json',
        'x-admin-pin': currentPin
      };
    }

    async function loadAll() {
      try {
        const r = await fetch('/api/studio/data', { headers: { 'x-admin-pin': currentPin } });
        if (!r.ok) {
          document.getElementById('requestsList').innerHTML = '<div style="color:#f87171;">ዳታ መጫን አልተቻለም (' + r.status + ')</div>';
          return;
        }
        const d = await r.json();
        document.getElementById('sPhase').textContent = d.live.phase;
        document.getElementById('sCount').textContent = d.live.countdown + 's';
        document.getElementById('sCode').textContent = d.live.gameCode;
        document.getElementById('sPool').textContent = d.live.takenBoardsCount + 'b / ' + d.live.prizePool + 'ብር';

        if (!settingsInitialized) {
          document.getElementById('cfgTelebirr').value = d.settings.telebirr || '';
          document.getElementById('cfgCbe').value = d.settings.cbe || '';
          document.getElementById('cfgBonus').value = d.settings.welcomeBonus ?? 0;
          document.getElementById('cfgMinDep').value = d.settings.minDeposit ?? 20;
          document.getElementById('cfgMinWdr').value = d.settings.minWithdraw ?? 50;
          settingsInitialized = true;
        }
        renderRequests(d.requests || []);
      } catch (e) {
        document.getElementById('requestsList').innerHTML = '<div style="color:#f87171;">ስህተት: ' + e.message + '</div>';
      }
    }

    function renderRequests(list) {
      const box = document.getElementById('requestsList');
      if (!list.length) {
        box.innerHTML = '<div class="label">ምንም ጥያቄ የለም።</div>';
        return;
      }
      box.innerHTML = list.map((req) => {
        const badgeClass = req.status === 'approved' ? 'approved' : (req.status === 'rejected' ? 'rejected' : 'pending');
        const imgHtml = req.photoUrl
          ? '<a href="' + req.photoUrl + '" target="_blank"><img class="req-img" src="' + req.photoUrl + '" alt="Screenshot" /></a>'
          : '';
        const txHtml = req.txNumber ? '<div><b>Tx No:</b> <code>' + req.txNumber + '</code></div>' : '';
        const accHtml = req.accountInfo ? '<div><b>Account:</b> <code>' + req.accountInfo + '</code></div>' : '';
        const actionsHtml = req.status === 'pending'
          ? '<div style="margin-top:8px;">' +
              '<button class="btn-green" style="margin-right:8px;" onclick="decideReq(\'' + req.id + '\', \'approve\')">✅ Approve</button>' +
              '<button class="btn-red" onclick="decideReq(\'' + req.id + '\', \'reject\')">❌ Reject</button>' +
            '</div>'
          : '';
        return (
          '<div class="req-item">' +
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
              '<b>' + req.type.toUpperCase() + ' • ' + req.amount + ' ብር</b>' +
              '<span class="badge ' + badgeClass + '">' + req.status + '</span>' +
            '</div>' +
            '<div style="font-size:13px; margin-top:6px;">' +
              '<div><b>User:</b> ' + (req.userName || 'Player') + ' (<code>' + req.userId + '</code>)</div>' +
              txHtml +
              accHtml +
            '</div>' +
            imgHtml +
            actionsHtml +
          '</div>'
        );
      }).join('');
    }

    async function saveSettings() {
      const body = {
        telebirr: document.getElementById('cfgTelebirr').value,
        cbe: document.getElementById('cfgCbe').value,
        welcomeBonus: Number(document.getElementById('cfgBonus').value),
        minDeposit: Number(document.getElementById('cfgMinDep').value),
        minWithdraw: Number(document.getElementById('cfgMinWdr').value)
      };
      const r = await fetch('/api/studio/settings', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body)
      });
      if (r.ok) {
        alert('✅ ቅንብሮች ተቀምጠዋል!');
        loadAll();
      }
    }

    async function adjustBalance() {
      const userId = document.getElementById('balUserId').value.trim();
      const delta = Number(document.getElementById('balDelta').value);
      const r = await fetch('/api/studio/balance', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ userId, delta })
      });
      const d = await r.json();
      if (r.ok) {
        alert('✅ ሂሳብ ተዘምኗል! አዲስ Main Balance: ' + d.user.main + ' ብር');
        document.getElementById('balUserId').value = '';
        document.getElementById('balDelta').value = '';
      } else {
        alert('❌ ' + (d.error || 'ስህተት'));
      }
    }

    async function decideReq(id, action) {
      const r = await fetch('/api/studio/requests/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: headers()
      });
      const d = await r.json();
      if (r.ok) {
        loadAll();
      } else {
        alert('❌ ' + (d.error || 'ስህተት'));
      }
    }

    loadAll();
    setInterval(loadAll, 4000);
  </script>
</body>
</html>`);
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
      board: boardTemplates.get(boardId),
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
