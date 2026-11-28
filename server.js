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
app.use(express.json({ limit: '10mb' }));

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
const SUPPORT_USER_ID = String(process.env.SUPPORT_USER_ID || ADMIN_ID).trim();
const SUPPORT_USERNAME = String(process.env.SUPPORT_USERNAME || SUPPORT_USER_ID).trim();

const HOUSE_COMMISSION = 0.20;
const LOBBY_SECONDS = 30;
const CALL_INTERVAL_MS = 2500;
const TOTAL_BOARDS = 600;

const DATA_FILE = path.join(__dirname, 'zina_bingo_data.json');
const BACKUP_FILE = path.join(__dirname, 'zina_bingo_data.bak.json');

let store = {
  settings: {
    telebirr: '09XXXXXXXX (ስም ያስገቡ)',
    cbe: '1000XXXXXXXXX (ስም ያስገቡ)',
    welcomeBonus: 10,
    minDeposit: 20,
    minWithdraw: 50
  },
  users: {},
  requests: {},
  claimedBonusUsers: {}
};

function parseStoreFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const rawStr = fs.readFileSync(filePath, 'utf8');
  if (!rawStr || !rawStr.trim()) return null;
  const raw = JSON.parse(rawStr);
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

function loadStore() {
  try {
    const primary = parseStoreFile(DATA_FILE);
    const backup = parseStoreFile(BACKUP_FILE);

    const primaryUsersCount = primary && primary.users ? Object.keys(primary.users).length : 0;
    const backupUsersCount = backup && backup.users ? Object.keys(backup.users).length : 0;

    const chosen = (primaryUsersCount === 0 && backupUsersCount > 0) ? backup : (primary || backup);
    if (chosen) {
      store.settings = { ...store.settings, ...(chosen.settings || {}) };
      store.users = chosen.users || {};
      store.requests = chosen.requests || {};
      store.claimedBonusUsers = chosen.claimedBonusUsers || {};
    }
  } catch (err) {
    console.error('Failed to load store:', err.message);
    try {
      const backup = parseStoreFile(BACKUP_FILE);
      if (backup) {
        store.settings = { ...store.settings, ...(backup.settings || {}) };
        store.users = backup.users || {};
        store.requests = backup.requests || {};
        store.claimedBonusUsers = backup.claimedBonusUsers || {};
      }
    } catch (bErr) {
      console.error('Failed to load backup store:', bErr.message);
    }
  }
}

let saveQueue = Promise.resolve();

function writeStoreNow(snapshotStr) {
  const tmpFile = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, snapshotStr, 'utf8');
  fs.renameSync(tmpFile, DATA_FILE);
  fs.writeFileSync(BACKUP_FILE, snapshotStr, 'utf8');
}

function saveStore() {
  let snapshotStr;
  try {
    snapshotStr = JSON.stringify(store, null, 2);
  } catch (err) {
    console.error('Failed to serialize store:', err.message);
    return Promise.resolve();
  }

  saveQueue = saveQueue
    .then(() => {
      writeStoreNow(snapshotStr);
    })
    .catch((err) => {
      console.error('Failed to save store:', err.message);
      try {
        writeStoreNow(snapshotStr);
      } catch (retryErr) {
        console.error('Retry save store failed:', retryErr.message);
      }
    });

  return saveQueue;
}

loadStore();

const adminSessions = new Map();

function addHistory(user, entry) {
  if (!Array.isArray(user.history)) user.history = [];
  user.history.unshift({
    ...entry,
    time: new Date().toISOString()
  });
  if (user.history.length > 200) {
    user.history = user.history.slice(0, 200);
  }
}

function normalizeUserRecord(u, key, info = {}) {
  if (!u || typeof u !== 'object') return null;
  u.id = String(key);
  if (info.firstName && info.firstName !== 'Guest') u.firstName = info.firstName;
  if (!u.firstName) u.firstName = 'Player';
  if (info.username) u.username = info.username;
  if (typeof u.username !== 'string') u.username = '';
  if (!u.status) u.status = 'active';
  if (!Array.isArray(u.history)) u.history = [];
  if (u.main == null || !Number.isFinite(Number(u.main))) u.main = 0;
  if (u.bonus == null || !Number.isFinite(Number(u.bonus))) u.bonus = 0;
  if (u.dep == null || !Number.isFinite(Number(u.dep))) u.dep = 0;
  if (u.withd == null || !Number.isFinite(Number(u.withd))) u.withd = 0;
  if (u.winsCount == null || !Number.isFinite(Number(u.winsCount))) u.winsCount = 0;
  if (u.totalWon == null || !Number.isFinite(Number(u.totalWon))) u.totalWon = 0;
  if (typeof u.bonusClaimed !== 'boolean') {
    u.bonusClaimed = Boolean(u.welcomeBonusGiven || store.claimedBonusUsers[String(key)] || Number(u.bonus) > 0);
  }
  u.welcomeBonusGiven = u.bonusClaimed;
  if (!u.createdAt) u.createdAt = new Date().toISOString();
  return u;
}

function getOrCreateUser(userId, info = {}) {
  const key = String(userId).trim();
  const defaultBonus = Number(store.settings.welcomeBonus) || 0;
  let changed = false;

  if (!store.users[key]) {
    const alreadyClaimedBefore = Boolean(store.claimedBonusUsers[key]);
    const grantBonus = !alreadyClaimedBefore && defaultBonus > 0;
    const initialBonus = grantBonus ? defaultBonus : 0;

    store.users[key] = normalizeUserRecord({
      id: key,
      firstName: info.firstName || 'Player',
      username: info.username || '',
      main: 0,
      bonus: initialBonus,
      dep: 0,
      withd: 0,
      winsCount: 0,
      totalWon: 0,
      status: 'active',
      bonusClaimed: grantBonus || alreadyClaimedBefore,
      welcomeBonusGiven: grantBonus || alreadyClaimedBefore,
      createdAt: new Date().toISOString(),
      history: []
    }, key, info);

    if (grantBonus) {
      store.claimedBonusUsers[key] = {
        claimedAt: new Date().toISOString(),
        amount: initialBonus
      };
      addHistory(store.users[key], {
        type: 'welcome_bonus',
        amount: initialBonus,
        note: 'የጀማሪ ቦነስ (አንድ ጊዜ ብቻ)'
      });
    }
    changed = true;
  } else {
    const prevFirst = store.users[key].firstName;
    const prevUser = store.users[key].username;
    normalizeUserRecord(store.users[key], key, info);
    if (store.users[key].bonusClaimed && !store.claimedBonusUsers[key]) {
      store.claimedBonusUsers[key] = {
        claimedAt: new Date().toISOString(),
        amount: Number(store.users[key].bonus || defaultBonus || 0)
      };
      changed = true;
    }
    if (prevFirst !== store.users[key].firstName || prevUser !== store.users[key].username) {
      changed = true;
    }
  }

  if (changed) {
    saveStore();
  }
  return store.users[key];
}

function getUserRequests(userId) {
  const uid = String(userId);
  return Object.values(store.requests || {})
    .filter((r) => String(r.userId) === uid)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function buildUserSummary(u) {
  const rec = normalizeUserRecord(u, u.id);
  const hist = Array.isArray(rec.history) ? rec.history : [];
  const winEntries = hist.filter((h) => h.type === 'win');
  const winsCount = Math.max(Number(rec.winsCount || 0), winEntries.length);
  const totalWonFromHist = winEntries.reduce((sum, h) => sum + (Number(h.amount) || 0), 0);
  const totalWon = Number(Math.max(Number(rec.totalWon || 0), totalWonFromHist).toFixed(2));

  return {
    id: rec.id,
    name: rec.firstName || 'Player',
    username: rec.username ? (rec.username.startsWith('@') ? rec.username : '@' + rec.username) : '@player',
    main: Number(Number(rec.main || 0).toFixed(2)),
    bonus: Number(Number(rec.bonus || 0).toFixed(2)),
    balance: Number(Number(rec.main || 0).toFixed(2)),
    totalDeposits: Number(Number(rec.dep || 0).toFixed(2)),
    totalWithdrawals: Number(Number(rec.withd || 0).toFixed(2)),
    winsCount,
    totalWon,
    bonusClaimed: Boolean(rec.bonusClaimed || store.claimedBonusUsers[rec.id]),
    status: rec.status || 'active',
    createdAt: rec.createdAt || '',
    history: hist,
    requests: getUserRequests(rec.id)
  };
}

function walletPayload(u) {
  const summary = buildUserSummary(u);
  return {
    userId: summary.id,
    main: summary.main,
    bonus: summary.bonus,
    balance: summary.balance,
    dep: summary.totalDeposits,
    withd: summary.totalWithdrawals,
    winsCount: summary.winsCount,
    totalWon: summary.totalWon,
    bonusClaimed: summary.bonusClaimed,
    settings: {
      telebirr: store.settings.telebirr,
      cbe: store.settings.cbe,
      welcomeBonus: Number(store.settings.welcomeBonus || 0),
      minDeposit: Number(store.settings.minDeposit || 20),
      minWithdraw: Number(store.settings.minWithdraw || 50)
    },
    history: summary.history,
    requests: summary.requests
  };
}

function emitWalletToUser(userId, targetSocket = null) {
  const uid = String(userId);
  const u = store.users[uid] || getOrCreateUser(uid);
  const payload = walletPayload(u);

  if (targetSocket) {
    targetSocket.emit('wallet:update', payload);
    targetSocket.emit('wallet:data', payload);
  }

  for (const [, sock] of io.sockets.sockets) {
    if (String(sock.data.userId || '') === uid) {
      sock.emit('wallet:update', payload);
      sock.emit('wallet:data', payload);
    }
  }
}

function deductStake(user, amount) {
  const amt = Number(amount || 0);
  const total = Number(((user.main || 0) + (user.bonus || 0)).toFixed(2));
  if (total < amt) return null;
  let usedMain = 0;
  let usedBonus = 0;
  if (user.main >= amt) {
    usedMain = amt;
    user.main = Number((user.main - amt).toFixed(2));
  } else {
    usedMain = Number((user.main || 0).toFixed(2));
    usedBonus = Number((amt - usedMain).toFixed(2));
    user.main = 0;
    user.bonus = Number(Math.max(0, (user.bonus || 0) - usedBonus).toFixed(2));
  }
  return { usedMain, usedBonus };
}

function refundStake(user, paidInfo) {
  if (!paidInfo) return;
  user.main = Number(((user.main || 0) + (paidInfo.usedMain || 0)).toFixed(2));
  user.bonus = Number(((user.bonus || 0) + (paidInfo.usedBonus || 0)).toFixed(2));
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
let nextRoundTimer = null;

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
        line: [0, 1, 2, 3, 4].map((c) => [r, c])
      };
    }
  }

  for (let c = 0; c < 5; c++) {
    if ([0, 1, 2, 3, 4].every((r) => isMarked(r, c))) {
      return {
        pattern: `Vertical (Col ${c + 1})`,
        line: [0, 1, 2, 3, 4].map((r) => [r, c])
      };
    }
  }

  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, i))) {
    return {
      pattern: 'Diagonal (Top-Left to Bottom-Right)',
      line: [0, 1, 2, 3, 4].map((i) => [i, i])
    };
  }

  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, 4 - i))) {
    return {
      pattern: 'Diagonal (Top-Right to Bottom-Left)',
      line: [0, 1, 2, 3, 4].map((i) => [i, 4 - i])
    };
  }

  if (isMarked(0, 0) && isMarked(0, 4) && isMarked(4, 0) && isMarked(4, 4)) {
    return {
      pattern: '4-Corners',
      line: [[0, 0], [0, 4], [4, 0], [4, 4]]
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
  getWallet(key);

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
    players: new Set([...gameState.takenBoards.values()].map((b) => b.socketId)).size
  });
  emitWalletToUser(key, socket);
}

function evaluateWinners() {
  if (gameState.phase !== 'PLAYING') return;
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
        line: winInfo.line
      });
    }
  }

  if (foundWinners.length > 0) {
    clearInterval(drawTimer);
    drawTimer = null;
    clearTimeout(nextRoundTimer);
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
      prize: splitAmount
    }));

    for (const w of foundWinners) {
      const wKey = String(w.userId || w.socketId);
      const user = getOrCreateUser(wKey, { firstName: w.name });
      user.main = Number(((user.main || 0) + splitAmount).toFixed(2));
      user.winsCount = Number(user.winsCount || 0) + 1;
      user.totalWon = Number(((user.totalWon || 0) + splitAmount).toFixed(2));
      addHistory(user, {
        type: 'win',
        amount: splitAmount,
        gameCode: gameState.gameCode,
        board: w.board,
        pattern: w.pattern
      });
      emitWalletToUser(wKey);
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

    nextRoundTimer = setTimeout(() => {
      startLobby();
    }, winSeconds * 1000);
  }
}

function startDrawing() {
  clearInterval(lobbyTimer);
  clearInterval(drawTimer);
  clearTimeout(nextRoundTimer);
  lobbyTimer = null;
  drawTimer = null;
  nextRoundTimer = null;

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
    if (gameState.phase !== 'PLAYING') {
      clearInterval(drawTimer);
      drawTimer = null;
      return;
    }

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
      nextRoundTimer = setTimeout(() => startLobby(), 6000);
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
  clearTimeout(nextRoundTimer);
  lobbyTimer = null;
  drawTimer = null;
  nextRoundTimer = null;

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

function tgApi(method, body = {}, timeoutMs = 12000) {
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

function getSupportContactInfo() {
  const clean = SUPPORT_USERNAME.trim();
  if (clean.startsWith('@')) {
    return {
      label: clean,
      url: `https://t.me/${clean.slice(1)}`
    };
  }
  const numericId = /^\d+$/.test(clean) ? clean : SUPPORT_USER_ID;
  return {
    label: `ID: ${numericId}`,
    url: `tg://user?id=${numericId}`
  };
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
    resize_keyboard: true,
    is_persistent: true
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
        { text: '🎁 ቦነስ ጨምር (User)', callback_data: 'adm_add_bonus' }
      ],
      [
        { text: '➕ Main ሂሳብ ጨምር/ቀንስ', callback_data: 'adm_add_balance' },
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
    `• *Welcome Bonus (አንድ ጊዜ):* *${store.settings.welcomeBonus} ብር*\n` +
    `• *Min Deposit:* *${store.settings.minDeposit} ብር*\n` +
    `• *Min Withdraw:* *${store.settings.minWithdraw} ብር*\n` +
    `• *Web Studio:* ${WEBAPP_URL}/studio?pin=${ADMIN_PIN}`;

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: msg,
    parse_mode: 'Markdown',
    reply_markup: getAdminKeyboard()
  });
}

async function sendPersistentKeyboardOnly(chatId, userId, text = '🎮 Zina Bingo Menu') {
  await tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: getMainMenuKeyboard(userId)
  });
}

async function sendJoinPrompt(chatId, userId, textPrefix = '') {
  const text =
    `${textPrefix ? textPrefix + '\n\n' : ''}` +
    `📢 *Zina Bingo*\n\n` +
    `አዳዲስ መልዕክቶች፣ ማስታወቂያዎች እና ዜናዎች ለማግኘት ቴሌግራም ቻናላችንን (*${CHANNEL_USERNAME}*) ይቀላቀሉ።\n` +
    `ከተቀላቀሉ በኋላ *"✅ ተቀላቅያለሁ"* የሚለውን ቁልፍ ይንኩ።`;

  await tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📢 ቻናል ይክፈቱ', url: CHANNEL_URL }],
        [{ text: '✅ ተቀላቅያለሁ', callback_data: 'verify_channel' }]
      ]
    }
  });

  await sendPersistentKeyboardOnly(chatId, userId, '👇 ከታች ያሉት ቁልፎች ሁሌም ይገኛሉ፦');
}

async function sendMainMenu(chatId, userId, firstName = 'Player') {
  getOrCreateUser(userId, { firstName });

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `Wellcome 👋 *${firstName}*`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎮 Play Game', web_app: { url: WEBAPP_URL } }]
      ]
    }
  });

  await tgApi('sendMessage', {
    chat_id: chatId,
    text:
      `📢 *Zina Bingo*\n\n` +
      `አዳዲስ መልዕክቶች፣ ማስታወቂያዎች እና ዜናዎች ለማግኘት ቴሌግራም ቻናላችንን ይቀላቀሉ።\n` +
      `👉 ቻናሉን አሁን ይክፈቱ (${CHANNEL_USERNAME})`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📢 ቻናል ይክፈቱ', url: CHANNEL_URL }]
      ]
    }
  });

  await sendPersistentKeyboardOnly(chatId, userId, 'ከታች ካሉት ቁልፎች አንዱን ይምረጡ፦');
}

function formatHistoryText(user) {
  const summary = buildUserSummary(user);
  if (!Array.isArray(summary.history) || summary.history.length === 0) {
    return '📜 *የእርስዎ ታሪክ (History)*\n\nእስካሁን ምንም የተመዘገበ ታሪክ የለም።';
  }
  const lines = summary.history.slice(0, 15).map((h) => {
    const d = h.time ? h.time.slice(0, 16).replace('T', ' ') : '';
    if (h.type === 'welcome_bonus') return `• 🎁 የጀማሪ ቦነስ: +${h.amount} ብር (${d})`;
    if (h.type === 'deposit_request') return `• ⏳ Deposit Req: +${h.amount} ብር (${d})`;
    if (h.type === 'deposit_approved') return `• 💰 Deposit (Approved): +${h.amount} ብር (${d})`;
    if (h.type === 'deposit_rejected') return `• ❌ Deposit (Rejected): ${h.amount} ብር (${d})`;
    if (h.type === 'withdraw_approved') return `• 💸 Withdraw (Approved): -${h.amount} ብር (${d})`;
    if (h.type === 'withdraw_request') return `• 💸 Withdraw Req: -${h.amount} ብር (${d})`;
    if (h.type === 'withdraw_rejected') return `• ❌ Withdraw (Rejected): +${h.amount} ብር (${d})`;
    if (h.type === 'win') return `• 🏆 ድል (${h.pattern}): +${h.amount} ብር (${d})`;
    if (h.type === 'admin_add') return `• 🛡️ Admin Main Adjust: ${h.amount >= 0 ? '+' : ''}${h.amount} ብር (${d})`;
    if (h.type === 'admin_bonus') return `• 🎁 Admin Bonus Added: +${h.amount} ብር (${d})`;
    return `• ℹ️ ${h.note || h.type}: ${h.amount ?? ''} (${d})`;
  });
  return (
    `📜 *የእርስዎ ሙሉ ማጠቃለያ እና ታሪክ*\n` +
    `• ጠቅላላ Deposit: *${summary.totalDeposits.toFixed(2)} ብር*\n` +
    `• ጠቅላላ Withdraw: *${summary.totalWithdrawals.toFixed(2)} ብር*\n` +
    `• ያሸነፉት ድል: *${summary.winsCount} ጊዜ (${summary.totalWon.toFixed(2)} ብር)*\n` +
    `• ቦነስ ሁኔታ: *${summary.bonusClaimed ? 'ተወስዷል ✅' : 'አልተወሰደም'}*\n\n` +
    lines.join('\n')
  );
}

function approveRequestById(reqId) {
  const reqObj = store.requests[reqId];
  if (!reqObj) return { ok: false, error: 'ጥያቄው አልተገኘም።' };
  if (reqObj.status !== 'pending') {
    return { ok: false, error: `ይህ ጥያቄ ቀድሞውኑ ${reqObj.status.toUpperCase()} ተደርጓል።` };
  }

  const uid = String(reqObj.userId);
  const targetUser = getOrCreateUser(uid, { firstName: reqObj.userName });

  if (reqObj.type === 'deposit') {
    const addAmt = Number(reqObj.amount || 0);
    targetUser.main = Number(((Number(targetUser.main) || 0) + addAmt).toFixed(2));
    targetUser.dep = Number(((Number(targetUser.dep) || 0) + addAmt).toFixed(2));
    store.users[uid] = targetUser;
    reqObj.status = 'approved';
    addHistory(targetUser, {
      type: 'deposit_approved',
      amount: addAmt,
      txNumber: reqObj.txNumber || '',
      reqId
    });
    saveStore();
    emitWalletToUser(uid);

    tgApi('sendMessage', {
      chat_id: uid,
      text:
        `✅ *ገንዘብዎ ገብቷል!* *${addAmt.toFixed(2)} ብር* በMain Balance ላይ ተጨምሯል።\n` +
        (reqObj.txNumber ? `🧾 Tx No: \`${reqObj.txNumber}\`\n` : '') +
        `💳 አዲስ Main Balance: *${targetUser.main.toFixed(2)} ብር*`,
      parse_mode: 'Markdown'
    });

    return { ok: true, request: reqObj, user: targetUser };
  }

  if (reqObj.type === 'withdraw') {
    const wAmt = Number(reqObj.amount || 0);
    const deductAlreadyHeld = Boolean(reqObj.amountHeld);
    if (!deductAlreadyHeld && targetUser.main < wAmt) {
      return { ok: false, error: 'በቂ Main Balance የለውም!' };
    }
    if (!deductAlreadyHeld) {
      targetUser.main = Number((targetUser.main - wAmt).toFixed(2));
    }
    targetUser.withd = Number(((Number(targetUser.withd) || 0) + wAmt).toFixed(2));
    store.users[uid] = targetUser;
    reqObj.status = 'approved';
    addHistory(targetUser, {
      type: 'withdraw_approved',
      amount: wAmt,
      reqId,
      accountInfo: reqObj.accountInfo
    });
    saveStore();
    emitWalletToUser(uid);

    tgApi('sendMessage', {
      chat_id: uid,
      text:
        `✅ የ *${wAmt.toFixed(2)} ብር* Withdraw ጥያቄዎ ተፈጽሟል።\n` +
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

  const uid = String(reqObj.userId);
  const targetUser = getOrCreateUser(uid, { firstName: reqObj.userName });
  if (reqObj.type === 'withdraw' && reqObj.amountHeld) {
    targetUser.main = Number(((Number(targetUser.main) || 0) + Number(reqObj.amount || 0)).toFixed(2));
    targetUser.withd = Number(Math.max(0, (Number(targetUser.withd) || 0) - Number(reqObj.amount || 0)).toFixed(2));
  }
  store.users[uid] = targetUser;
  reqObj.status = 'rejected';
  addHistory(targetUser, {
    type: `${reqObj.type}_rejected`,
    amount: reqObj.amount,
    note: `${reqObj.type} rejected`
  });
  saveStore();
  emitWalletToUser(uid);

  const supportInfo = getSupportContactInfo();
  tgApi('sendMessage', {
    chat_id: uid,
    text: `❌ የእርስዎ የ *${reqObj.type.toUpperCase()}* (\`${reqId}\`፣ *${reqObj.amount} ብር*) ጥያቄ ተቀባይነት አላገኘም። ዝርዝር ካስፈለገዎት ${supportInfo.label} ያነጋግሩ።`,
    parse_mode: 'Markdown'
  });

  return { ok: true, request: reqObj, user: targetUser };
}

const MENU_BUTTONS = new Set([
  '💰 Deposit',
  '💸 Withdraw',
  '💳 Balance',
  '📜 History',
  '📞 Support',
  '📊 Instructions',
  '🎁 Invite Friends',
  '🛡️ Admin Panel'
]);

async function handleBotMessage(msg) {
  const chatId = msg.chat?.id;
  const user = msg.from;
  const text = (msg.text || msg.caption || '').trim();
  const photos = Array.isArray(msg.photo) ? msg.photo : [];
  if (!chatId || !user || (!text && photos.length === 0)) return;

  const u = getOrCreateUser(user.id, {
    firstName: user.first_name || 'Player',
    username: user.username || ''
  });

  const member = await isChannelMember(user.id);
  if (!member) {
    await sendJoinPrompt(chatId, user.id);
    return;
  }

  if (text === '/start' || text.startsWith('/start ')) {
    adminSessions.delete(user.id);
    await sendMainMenu(chatId, user.id, user.first_name || 'Player');
    return;
  }

  if (MENU_BUTTONS.has(text)) {
    adminSessions.delete(user.id);
  }

  const session = adminSessions.get(user.id);
  if (session && !text.startsWith('/') && !MENU_BUTTONS.has(text)) {
    if (session.mode === 'await_deposit_amount') {
      const amt = Number(text);
      if (!Number.isFinite(amt) || amt < Number(store.settings.minDeposit)) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `❌ እባክዎ ትክክለኛ የገንዘብ መጠን (ቢያንስ *${store.settings.minDeposit} ብር*) በቁጥር ያስገቡ።`,
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
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
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(user.id)
      });
      return;
    }

    if (session.mode === 'await_deposit_tx') {
      const txNumber = text.trim();
      if (txNumber.length < 4) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: '❌ እባክዎ ትክክለኛ **Transaction No** ይጻፉ።',
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
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
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(user.id)
      });
      return;
    }

    if (session.mode === 'await_deposit_photo') {
      if (photos.length === 0) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: '❌ እባክዎ የክፍያውን **Screenshot (ፎቶ)** ብቻ ይላኩ።',
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
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

      const freshUser = getOrCreateUser(user.id, {
        firstName: user.first_name || 'Player',
        username: user.username || ''
      });

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
      addHistory(freshUser, {
        type: 'deposit_request',
        amount: Number(session.tempAmount),
        txNumber: session.txNumber,
        reqId
      });
      saveStore();
      emitWalletToUser(user.id);
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
          `• Studio: ${WEBAPP_URL}/studio?pin=${ADMIN_PIN}`,
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
      const freshUser = getOrCreateUser(user.id, {
        firstName: user.first_name || 'Player',
        username: user.username || ''
      });

      if (!Number.isFinite(amt) || amt < Number(store.settings.minWithdraw)) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `❌ ዝቅተኛው የማውጫ መጠን *${store.settings.minWithdraw} ብር* ነው። እባክዎ መጠን እና አካውንት ያስገቡ (ለምሳሌ፡ \`100 0911223344\`)።`,
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
        });
        return;
      }
      if (!accountInfo) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `❌ እባክዎ የገንዘብ መቀበያ ስልክ ቁጥር ወይም አካውንት አብረው ያስገቡ (ለምሳሌ፡ \`100 0911223344\`)።`,
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
        });
        return;
      }
      if (freshUser.main < amt) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `❌ በቂ *Main Balance* የለዎትም! ያለዎት Main Balance: *${freshUser.main.toFixed(2)} ብር* ነው (Bonus Balance በቀጥታ ወጪ አይሆንም)።`,
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
        });
        return;
      }

      freshUser.main = Number((freshUser.main - amt).toFixed(2));
      const reqId = `WDR_${Date.now()}_${user.id}`;
      store.requests[reqId] = {
        id: reqId,
        type: 'withdraw',
        userId: String(user.id),
        userName: user.first_name || 'Player',
        amount: Number(amt.toFixed(2)),
        accountInfo,
        amountHeld: true,
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      addHistory(freshUser, {
        type: 'withdraw_request',
        amount: Number(amt.toFixed(2)),
        reqId,
        accountInfo
      });
      saveStore();
      emitWalletToUser(user.id);
      adminSessions.delete(user.id);

      await tgApi('sendMessage', {
        chat_id: chatId,
        text:
          `✅ *የWithdraw ጥያቄዎ ተልኳል!*\n\n` +
          `• Request ID: \`${reqId}\`\n` +
          `• መጠን: *${amt.toFixed(2)} ብር*\n` +
          `• አካውንት: \`${accountInfo}\`\n` +
          `• ቀሪ Main Balance: *${freshUser.main.toFixed(2)} ብር*\n` +
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
          `• ቀሪ Main Balance: *${freshUser.main.toFixed(2)} ብር*\n` +
          `• የሚወጣ መጠን: *${amt.toFixed(2)} ብር*\n` +
          `• መቀበያ አካውንት: \`${accountInfo}\`\n` +
          `• Studio: ${WEBAPP_URL}/studio?pin=${ADMIN_PIN}`,
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
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
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
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
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
            parse_mode: 'Markdown',
            reply_markup: getMainMenuKeyboard(user.id)
          });
          return;
        }
        store.settings.welcomeBonus = bonusVal;
        saveStore();
        adminSessions.delete(user.id);
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `✅ የጀማሪ ቦነስ (አንድ ጊዜ ብቻ) ወደ *${bonusVal} ብር* ተቀይሯል።`,
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
        });
        await sendAdminPanel(chatId);
        return;
      }

      if (session.mode === 'add_bonus') {
        const parts = text.split(/\s+/);
        const targetId = String(parts[0] || '').trim();
        const bonusDelta = Number(parts[1]);

        if (!targetId || !Number.isFinite(bonusDelta) || bonusDelta <= 0) {
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: '❌ ቅርጸት፡ `<UserID> <BonusAmount>` (ለምሳሌ፡ `123456789 20`)።',
            parse_mode: 'Markdown',
            reply_markup: getMainMenuKeyboard(user.id)
          });
          return;
        }

        const targetUser = getOrCreateUser(targetId);
        targetUser.bonus = Number(((Number(targetUser.bonus) || 0) + bonusDelta).toFixed(2));
        targetUser.bonusClaimed = true;
        targetUser.welcomeBonusGiven = true;
        store.claimedBonusUsers[targetId] = store.claimedBonusUsers[targetId] || {
          claimedAt: new Date().toISOString(),
          amount: bonusDelta
        };
        addHistory(targetUser, {
          type: 'admin_bonus',
          amount: bonusDelta,
          note: 'Admin bonus added'
        });
        saveStore();
        emitWalletToUser(targetId);
        adminSessions.delete(user.id);

        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `✅ ለተጠቃሚ \`${targetId}\` *+${bonusDelta.toFixed(2)} ብር* ቦነስ ተጨምሯል። አዲስ Bonus: *${targetUser.bonus.toFixed(2)} ብር*።`,
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
        });

        await tgApi('sendMessage', {
          chat_id: targetId,
          text: `🎁 በአስተዳዳሪ በኩል *+${bonusDelta.toFixed(2)} ብር* ቦነስ ተጨምሮልዎታል። አዲስ Bonus: *${targetUser.bonus.toFixed(2)} ብር*።`,
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
            parse_mode: 'Markdown',
            reply_markup: getMainMenuKeyboard(user.id)
          });
          return;
        }

        const targetUser = getOrCreateUser(targetId);
        const nextMain = Number(((Number(targetUser.main) || 0) + delta).toFixed(2));
        if (nextMain < 0) {
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: `❌ ከዜሮ በታች ሊሆን አይችልም! የተጫዋቹ Main Balance: *${Number(targetUser.main || 0).toFixed(2)} ብር* ነው።`,
            parse_mode: 'Markdown',
            reply_markup: getMainMenuKeyboard(user.id)
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
        emitWalletToUser(targetId);
        adminSessions.delete(user.id);

        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `✅ የተጠቃሚ \`${targetId}\` አዲስ Main Balance: *${targetUser.main.toFixed(2)} ብር*።`,
          parse_mode: 'Markdown',
          reply_markup: getMainMenuKeyboard(user.id)
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

  if (text === '/admin' || text === '🛡️ Admin Panel') {
    if (!isAdmin(user.id)) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '⛔ ይህ ክፍል ለአስተዳዳሪ (Admin) ብቻ ነው።',
        reply_markup: getMainMenuKeyboard(user.id)
      });
      return;
    }
    await sendAdminPanel(chatId);
    return;
  }

  if (text === '💳 Balance') {
    const freshU = store.users[String(user.id)] || u;
    const summary = buildUserSummary(freshU);
    const totalBal = Number((summary.main + summary.bonus).toFixed(2));
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `💳 *የZina Bingo ቀሪ ሂሳብዎ*\n\n` +
        `👤 ስም: *${summary.name}*\n` +
        `🆔 ID: \`${user.id}\`\n` +
        `💰 Main Balance: *${summary.main.toFixed(2)} ብር*\n` +
        `🎁 Bonus: *${summary.bonus.toFixed(2)} ብር* (${summary.bonusClaimed ? 'ቦነስ ተወስዷል ✅' : 'ቦነስ አልተወሰደም'})\n` +
        `🏆 ድል: *${summary.winsCount} ጊዜ (${summary.totalWon.toFixed(2)} ብር)*\n` +
        `📊 አጠቃላይ (Main + Bonus): *${totalBal.toFixed(2)} ብር*`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard(user.id)
    });
    return;
  }

  if (text === '📜 History') {
    const freshU = store.users[String(user.id)] || u;
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: formatHistoryText(freshU),
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
    const freshU = store.users[String(user.id)] || u;
    adminSessions.set(user.id, { mode: 'await_withdraw_request' });
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `💸 *ገንዘብ ማውጫ (Withdraw) — Zina Bingo*\n\n` +
        `• *Main Balance:* *${Number(freshU.main || 0).toFixed(2)} ብር*\n` +
        `• *Bonus Balance:* *${Number(freshU.bonus || 0).toFixed(2)} ብር* (በቀጥታ ወጪ አይሆንም)\n` +
        `• *ዝቅተኛ ማውጫ:* *${store.settings.minWithdraw} ብር*\n\n` +
        `የሚያወጡትን መጠን እና የመቀበያ ስልክ/አካውንት በአንድ መስመር ይጻፉ\n` +
        `ምሳሌ፦ \`100 0911223344\``,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard(user.id)
    });
    return;
  }

  if (text === '📞 Support') {
    const supportInfo = getSupportContactInfo();
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `📞 *Zina Bingo Support*\n\n` +
        `🆔 የእርስዎ ID: \`${user.id}\`\n` +
        `ችግር ሲያጋጥምዎት ከታች ባለው ቁልፍ ወደ አስተዳዳሪው የግል መልዕክት ይላኩ፦\n` +
        `• የግል መለያ: \`${supportInfo.label}\``,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 ወደ የግል መልዕክት ላክ (Direct PM)', url: supportInfo.url }]
        ]
      }
    });
    await sendPersistentKeyboardOnly(chatId, user.id, '👇 የሜኑ ቁልፎች፦');
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

  getOrCreateUser(user.id, {
    firstName: user.first_name || 'Player',
    username: user.username || ''
  });

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
      await sendJoinPrompt(chatId, user.id);
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
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(user.id)
      });
      return;
    }

    if (data === 'adm_set_cbe') {
      adminSessions.set(user.id, { mode: 'set_cbe' });
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '🏦 አዲሱን የCBE አካውንት ቁጥር እና ስም ይጻፉ (ለምሳሌ፡ `1000123456789 - Zina Bingo`)፦',
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(user.id)
      });
      return;
    }

    if (data === 'adm_set_bonus') {
      adminSessions.set(user.id, { mode: 'set_bonus' });
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '🎁 ለአዲስ ጀማሪ አንድ ጊዜ ብቻ የሚሰጠውን የቦነስ መጠን በቁጥር ይጻፉ (ለምሳሌ፡ `10`)፦',
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(user.id)
      });
      return;
    }

    if (data === 'adm_add_bonus') {
      adminSessions.set(user.id, { mode: 'add_bonus' });
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '🎁 ቦነስ የምትጨምርለትን User ID እና የቦነስ ብር መጠን ይጻፉ\nምሳሌ፦ `123456789 20`፦',
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(user.id)
      });
      return;
    }

    if (data === 'adm_add_balance') {
      adminSessions.set(user.id, { mode: 'add_balance' });
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '➕ የተጫዋቹን User ID እና Main ብር መጠን ይጻፉ\nምሳሌ፦ `123456789 50` (ወይም ለመቀነስ `123456789 -20`)፦',
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(user.id)
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
        ? `✅ ጥያቄ \`${reqId}\` Approved ተደርጓል። የተጫዋቹ Main Balance: *${Number(resObj.user.main || 0).toFixed(2)} ብር*።`
        : `❌ ጥያቄ \`${reqId}\` Rejected ተደርጓል።`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard(user.id)
    });
  }
}

async function startBotPolling() {
  if (!BOT_TOKEN) {
    console.warn('BOT_TOKEN is not set; Telegram bot polling skipped.');
    return;
  }

  await tgApi('deleteWebhook', { drop_pending_updates: false });
  await tgApi('setMyCommands', {
    commands: [
      { command: 'start', description: 'ዋና ማውጫ / Main Menu' },
      { command: 'admin', description: 'Admin Panel' }
    ]
  });
  await tgApi('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: '🎮 Play Game',
      web_app: { url: WEBAPP_URL }
    }
  });
  console.log('Telegram bot polling started (IPv4).');

  let offset = 0;
  while (true) {
    try {
      const data = await tgApi('getUpdates', { timeout: 20, offset }, 30000);
      if (data?.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const incomingUser =
            update.message?.from ||
            update.callback_query?.from ||
            update.my_chat_member?.from ||
            update.chat_member?.from;
          const incomingChatId =
            update.message?.chat?.id ||
            update.callback_query?.message?.chat?.id ||
            update.my_chat_member?.chat?.id ||
            update.chat_member?.chat?.id;

          if (incomingUser && incomingChatId) {
            getOrCreateUser(incomingUser.id, {
              firstName: incomingUser.first_name || 'Player',
              username: incomingUser.username || ''
            });
          }

          if (update.my_chat_member && incomingChatId && incomingUser) {
            const newSt = update.my_chat_member.new_chat_member?.status;
            if (['member', 'administrator'].includes(newSt)) {
              await sendMainMenu(incomingChatId, incomingUser.id, incomingUser.first_name || 'Player');
            }
          }

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
  if (pin === ADMIN_PIN || pin === String(ADMIN_ID)) {
    return next();
  }
  return res.status(403).json({ ok: false, error: 'Admin access required.' });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/studio', (req, res) => {
  res.sendFile(path.join(__dirname, 'studio.html'));
});

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

app.get('/api/wallet/:userId', (req, res) => {
  const uid = String(req.params.userId || '').trim();
  if (!uid) return res.status(400).json({ ok: false, error: 'Missing userId' });
  const u = store.users[uid] || getOrCreateUser(uid);
  return res.json({ ok: true, wallet: walletPayload(u) });
});

app.get('/api/studio/data', requireStudioPin, (req, res) => {
  const requestsList = Object.values(store.requests).sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );
  const usersList = Object.values(store.users).map((u) => buildUserSummary(u));
  res.json({
    ok: true,
    live: {
      phase: gameState.phase,
      countdown: gameState.countdown,
      gameId: gameState.gameId,
      gameCode: gameState.gameCode,
      stake: gameState.stake,
      takenBoardsCount: gameState.takenBoards.size,
      totalBoards: TOTAL_BOARDS,
      prizePool: calculatePrizePool()
    },
    settings: store.settings,
    requests: requestsList,
    users: usersList,
    usersCount: usersList.length
  });
});

app.get('/api/studio/export', requireStudioPin, (req, res) => {
  res.json({
    ok: true,
    exportedAt: new Date().toISOString(),
    data: store
  });
});

app.post('/api/studio/import', requireStudioPin, (req, res) => {
  const incoming = req.body?.data || req.body;
  if (!incoming || typeof incoming !== 'object' || !incoming.users || typeof incoming.users !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid import payload.' });
  }
  store.settings = { ...store.settings, ...(incoming.settings || {}) };
  store.users = incoming.users;
  store.requests = incoming.requests || {};
  store.claimedBonusUsers = { ...(store.claimedBonusUsers || {}), ...(incoming.claimedBonusUsers || {}) };
  for (const [uid, rec] of Object.entries(store.users)) {
    normalizeUserRecord(rec, uid);
    if (rec.bonusClaimed) {
      store.claimedBonusUsers[uid] = store.claimedBonusUsers[uid] || {
        claimedAt: new Date().toISOString(),
        amount: Number(rec.bonus || store.settings.welcomeBonus || 0)
      };
    }
  }
  saveStore();
  return res.json({ ok: true, usersCount: Object.keys(store.users).length });
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
  const delta = Number(req.body?.delta ?? req.body?.mainDelta ?? 0);
  const bonusDelta = Number(req.body?.bonusDelta || 0);
  if (!targetId || (!Number.isFinite(delta) && !Number.isFinite(bonusDelta))) {
    return res.status(400).json({ ok: false, error: 'User ID እና Amount ያስገቡ።' });
  }
  const targetUser = getOrCreateUser(targetId);
  const nextMain = Number(((Number(targetUser.main) || 0) + (Number.isFinite(delta) ? delta : 0)).toFixed(2));
  const nextBonus = Number(((Number(targetUser.bonus) || 0) + (Number.isFinite(bonusDelta) ? bonusDelta : 0)).toFixed(2));
  if (nextMain < 0 || nextBonus < 0) {
    return res.status(400).json({ ok: false, error: 'ሂሳብ ከዜሮ በታች ሊሆን አይችልም።' });
  }
  targetUser.main = nextMain;
  targetUser.bonus = nextBonus;
  if (bonusDelta > 0) {
    targetUser.bonusClaimed = true;
    targetUser.welcomeBonusGiven = true;
    store.claimedBonusUsers[targetId] = store.claimedBonusUsers[targetId] || {
      claimedAt: new Date().toISOString(),
      amount: bonusDelta
    };
  }
  if (delta !== 0) {
    addHistory(targetUser, {
      type: 'admin_add',
      amount: delta,
      note: 'Studio main adjustment'
    });
  }
  if (bonusDelta !== 0) {
    addHistory(targetUser, {
      type: 'admin_bonus',
      amount: bonusDelta,
      note: 'Studio bonus adjustment'
    });
  }
  saveStore();
  emitWalletToUser(targetId);

  tgApi('sendMessage', {
    chat_id: targetId,
    text:
      `ℹ️ በአስተዳዳሪ በኩል በሂሳብዎ ላይ ለውጥ ተደርጓል።\n` +
      (delta !== 0 ? `• Main: *${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ብር* (አዲስ: *${targetUser.main.toFixed(2)} ብር*)\n` : '') +
      (bonusDelta !== 0 ? `• Bonus: *${bonusDelta >= 0 ? '+' : ''}${bonusDelta.toFixed(2)} ብር* (አዲስ: *${targetUser.bonus.toFixed(2)} ብር*)` : ''),
    parse_mode: 'Markdown'
  });

  res.json({ ok: true, user: buildUserSummary(targetUser) });
});

app.post('/api/studio/player-status', requireStudioPin, (req, res) => {
  const targetId = String(req.body?.userId || '').trim();
  const status = String(req.body?.status || '').trim();
  if (!targetId || !['active', 'frozen', 'banned'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'Invalid user or status.' });
  }
  const targetUser = getOrCreateUser(targetId);
  targetUser.status = status;
  saveStore();
  res.json({ ok: true, user: buildUserSummary(targetUser) });
});

app.post('/api/studio/game-control', requireStudioPin, (req, res) => {
  const action = String(req.body?.action || '').trim();
  const stake = Number(req.body?.stake);
  if (Number.isFinite(stake) && stake >= 1) {
    gameState.stake = stake;
  }
  if (action === 'start' || action === 'restart') {
    startLobby();
  } else if (action === 'play_now') {
    startDrawing();
  } else if (action === 'pause') {
    clearInterval(lobbyTimer);
    clearInterval(drawTimer);
    clearTimeout(nextRoundTimer);
    lobbyTimer = null;
    drawTimer = null;
    nextRoundTimer = null;
    gameState.phase = 'PAUSED';
  }
  res.json({
    ok: true,
    live: {
      phase: gameState.phase,
      countdown: gameState.countdown,
      gameId: gameState.gameId,
      gameCode: gameState.gameCode,
      stake: gameState.stake,
      takenBoardsCount: gameState.takenBoards.size,
      prizePool: calculatePrizePool()
    }
  });
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

app.use(express.static(__dirname));

io.on('connection', (socket) => {
  socket.on('wallet:get', (payload = {}) => {
    const uid = String((payload.user && payload.user.id) || payload.userId || getSocketKey(socket));
    if (payload.user && payload.user.id) {
      socket.data.userId = String(payload.user.id);
      if (payload.user.name) socket.data.username = payload.user.name;
    }
    getOrCreateUser(uid, {
      firstName: (payload.user && payload.user.name) || socket.data.username || 'Player'
    });
    emitWalletToUser(uid, socket);
  });

  socket.on('room:join', (payload = {}) => {
    if (payload.stake && gameState.phase === 'LOBBY' && gameState.takenBoards.size === 0) {
      gameState.stake = Number(payload.stake) || gameState.stake;
    }
    if (payload.user) {
      socket.data.userId = payload.user.id ? String(payload.user.id) : socket.id;
      socket.data.username = payload.user.name || 'Player';
      getOrCreateUser(socket.data.userId, { firstName: socket.data.username });
    }
    emitRoomStateToSocket(socket);
  });

  socket.on('room:leave', () => {
    const key = getSocketKey(socket);
    const user = getOrCreateUser(key, { firstName: socket.data.username || 'Player' });
    let changed = false;
    let refunded = false;

    for (const [boardId, info] of gameState.takenBoards.entries()) {
      if (info.socketId === socket.id && gameState.phase === 'LOBBY') {
        if (info.paidInfo) {
          refundStake(user, info.paidInfo);
          refunded = true;
        }
        gameState.takenBoards.delete(boardId);
        io.emit('board:released', { board: boardId, booked: getBookedMap() });
        changed = true;
      }
    }

    if (refunded) {
      saveStore();
      emitWalletToUser(key, socket);
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

  socket.on('board:pick', (payload = {}) => {
    const boardId = Number(payload.board);
    if (payload.user) {
      socket.data.userId = payload.user.id ? String(payload.user.id) : socket.data.userId || socket.id;
      socket.data.username = payload.user.name || socket.data.username || 'Player';
    }
    const username = socket.data.username || 'Player';
    const userId = getSocketKey(socket);
    const user = getOrCreateUser(userId, { firstName: username });

    if (user.status && user.status !== 'active') {
      socket.emit('board:rejected', { board: boardId, reason: 'restricted' });
      return;
    }

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

    const paidInfo = deductStake(user, gameState.stake);
    if (!paidInfo) {
      socket.emit('board:rejected', { board: boardId, reason: 'insufficient', need: gameState.stake });
      emitWalletToUser(userId, socket);
      return;
    }

    gameState.takenBoards.set(boardId, {
      boardId,
      board: boardTemplates.get(boardId),
      socketId: socket.id,
      userId,
      username,
      paidInfo
    });
    saveStore();

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
    emitWalletToUser(userId, socket);
  });

  const releaseBoardHandler = (payload = {}) => {
    const boardId = Number(payload.board);
    if (gameState.phase !== 'LOBBY') return;

    const entry = gameState.takenBoards.get(boardId);
    if (entry && entry.socketId === socket.id) {
      const uid = entry.userId || getSocketKey(socket);
      const user = getOrCreateUser(uid, { firstName: entry.username });
      refundStake(user, entry.paidInfo);
      gameState.takenBoards.delete(boardId);
      saveStore();

      io.emit('board:released', {
        board: boardId,
        booked: getBookedMap()
      });
      emitWalletToUser(uid, socket);
    }
  };

  socket.on('board:release', releaseBoardHandler);
  socket.on('board:unpick', releaseBoardHandler);

  socket.on('wallet:deposit_req', (payload = {}) => {
    const uInfo = payload.user || {};
    const userId = String(uInfo.id || payload.userId || getSocketKey(socket));
    const userName = uInfo.name || socket.data.username || 'Player';
    const amount = Number(payload.amount);
    const txNumber = String(payload.txNumber || '').trim();
    const photoData = String(payload.photoData || '').trim();

    const user = getOrCreateUser(userId, { firstName: userName });

    if (!Number.isFinite(amount) || amount < Number(store.settings.minDeposit) || txNumber.length < 3) {
      socket.emit('wallet:req_error', {
        type: 'deposit',
        message: `ቢያንስ ${store.settings.minDeposit} ብር እና ትክክለኛ Transaction No ያስገቡ።`
      });
      emitWalletToUser(userId, socket);
      return;
    }

    const reqId = `DEP_${Date.now()}_${userId}`;
    let photoUrl = '';

    const match = photoData.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
    if (match) {
      const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
      const buf = Buffer.from(match[2], 'base64');
      if (buf.length > 0 && buf.length <= 5 * 1024 * 1024) {
        const fileName = `${reqId}.${ext}`;
        const fullPath = path.join(UPLOADS_DIR, fileName);
        try {
          fs.writeFileSync(fullPath, buf);
          photoUrl = `/uploads/${fileName}`;
        } catch (err) {
          console.error('MiniApp screenshot save error:', err.message);
        }
      }
    }

    store.requests[reqId] = {
      id: reqId,
      type: 'deposit',
      userId,
      userName,
      amount: Number(amount.toFixed(2)),
      txNumber,
      photoUrl,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    addHistory(user, {
      type: 'deposit_request',
      amount: Number(amount.toFixed(2)),
      txNumber,
      reqId
    });
    saveStore();
    emitWalletToUser(userId, socket);

    socket.emit('wallet:req_submitted', {
      type: 'deposit',
      reqId,
      amount: Number(amount.toFixed(2)),
      txNumber
    });

    tgApi('sendMessage', {
      chat_id: ADMIN_ID,
      text:
        `💰 *ከMini App የDeposit ጥያቄ!*\n\n` +
        `• Request ID: \`${reqId}\`\n` +
        `• ተጫዋች: *${userName}* (\`${userId}\`)\n` +
        `• መጠን: *${amount.toFixed(2)} ብር*\n` +
        `• Transaction No: \`${txNumber}\`\n` +
        `• Screenshot: ${photoUrl ? 'ተልኳል ✅' : 'የለም'}\n` +
        `• Studio: ${WEBAPP_URL}/studio?pin=${ADMIN_PIN}`,
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
  });

  socket.on('wallet:withdraw_req', (payload = {}) => {
    const uInfo = payload.user || {};
    const userId = String(uInfo.id || payload.userId || getSocketKey(socket));
    const userName = uInfo.name || socket.data.username || 'Player';
    const amount = Number(payload.amount);
    const accountInfo = String(payload.accountInfo || '').trim();

    const user = getOrCreateUser(userId, { firstName: userName });

    if (!Number.isFinite(amount) || amount < Number(store.settings.minWithdraw) || !accountInfo) {
      socket.emit('wallet:req_error', {
        type: 'withdraw',
        message: `ዝቅተኛው ማውጫ ${store.settings.minWithdraw} ብር ነው። መጠን እና አካውንት ያስገቡ።`
      });
      emitWalletToUser(userId, socket);
      return;
    }

    if (user.main < amount) {
      socket.emit('wallet:req_error', {
        type: 'withdraw',
        message: `በቂ Main Balance የለዎትም! ያለዎት Main Balance: ${user.main.toFixed(2)} ብር ነው።`
      });
      emitWalletToUser(userId, socket);
      return;
    }

    user.main = Number((user.main - amount).toFixed(2));
    const reqId = `WDR_${Date.now()}_${userId}`;
    store.requests[reqId] = {
      id: reqId,
      type: 'withdraw',
      userId,
      userName,
      amount: Number(amount.toFixed(2)),
      accountInfo,
      amountHeld: true,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    addHistory(user, {
      type: 'withdraw_request',
      amount: Number(amount.toFixed(2)),
      reqId,
      accountInfo
    });
    saveStore();
    emitWalletToUser(userId, socket);

    socket.emit('wallet:req_submitted', {
      type: 'withdraw',
      reqId,
      amount: Number(amount.toFixed(2)),
      accountInfo
    });

    tgApi('sendMessage', {
      chat_id: ADMIN_ID,
      text:
        `💸 *ከMini App የWithdraw ጥያቄ!*\n\n` +
        `• Request ID: \`${reqId}\`\n` +
        `• ተጫዋች: *${userName}* (\`${userId}\`)\n` +
        `• ቀሪ Main Balance: *${user.main.toFixed(2)} ብር*\n` +
        `• የሚወጣ መጠን: *${amount.toFixed(2)} ብር*\n` +
        `• መቀበያ አካውንት: \`${accountInfo}\`\n` +
        `• Studio: ${WEBAPP_URL}/studio?pin=${ADMIN_PIN}`,
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
  });

  socket.on('disconnect', () => {
    let changed = false;
    for (const [boardId, entry] of gameState.takenBoards.entries()) {
      if (entry.socketId === socket.id) {
        if (gameState.phase === 'LOBBY' && entry.paidInfo) {
          const user = getOrCreateUser(entry.userId || getSocketKey(socket), { firstName: entry.username });
          refundStake(user, entry.paidInfo);
        }
        gameState.takenBoards.delete(boardId);
        changed = true;
      }
    }
    if (changed) {
      saveStore();
      if (gameState.phase === 'LOBBY') {
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
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Bingo server running on port ${PORT}`);
  startLobby();
  startBotPolling();
});
