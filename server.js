const express = require('express');
const http = require('http');
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
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@zinabingo';
const CHANNEL_URL = process.env.CHANNEL_URL || 'https://t.me/zinabingo';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://ela-jbix.onrender.com';
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || '@ZinaBingoBot';

const HOUSE_COMMISSION = 0.20;
const LOBBY_SECONDS = 30;
const CALL_INTERVAL_MS = 2500;
const TOTAL_BOARDS = 600;

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

const wallets = new Map();

function getWallet(key) {
  if (!wallets.has(key)) {
    wallets.set(key, { main: 0, bonus: 0, dep: 0 });
  }
  return wallets.get(key);
}

function getSocketKey(socket) {
  return socket.data.userId || socket.id;
}

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
    wallet: getWallet(key)
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
      const wKey = w.userId || w.socketId;
      const wallet = getWallet(wKey);
      wallet.main = Number((wallet.main + splitAmount).toFixed(2));
      io.to(w.socketId).emit('wallet:update', wallet);
    }

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
async function tgApi(method, body = {}) {
  if (!BOT_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
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

function getMainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: '🎮 Play Game', web_app: { url: WEBAPP_URL } }],
      [{ text: '💰 Deposit' }, { text: '💸 Withdraw' }],
      [{ text: '💳 Balance' }],
      [{ text: '📞 Support' }, { text: '📊 Instructions' }],
      [{ text: '🎁 Invite Friends' }]
    ],
    resize_keyboard: true
  };
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

async function sendMainMenu(chatId, firstName = 'Player') {
  const text =
    `🎉 *እንኳን ወደ Zina Bingo በደህና መጡ፣ ${firstName}!*\n\n` +
    `ከታች ካሉት ቁልፎች አንዱን በመምረጥ ይጀምሩ፦`;

  await tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: getMainMenuKeyboard()
  });
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

  const wallet = getWallet(String(user.id));

  if (text === '/start' || text.startsWith('/start ')) {
    await sendMainMenu(chatId, user.first_name || 'Player');
    return;
  }

  if (text === '💳 Balance') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `💳 *የZina Bingo ቀሪ ሂሳብዎ*\n\n` +
        `🆔 ID: \`${user.id}\`\n` +
        `💰 Main Balance: *${wallet.main.toFixed(2)}*\n` +
        `🎁 Bonus: *${wallet.bonus.toFixed(2)}*`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard()
    });
    return;
  }

  if (text === '💰 Deposit') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `💰 *ገንዘብ ማስገቢያ (Deposit) — Zina Bingo*\n\n` +
        `🆔 የእርስዎ ID: \`${user.id}\`\n` +
        `ለማስገባት ድጋፍን ያነጋግሩ፦ ${SUPPORT_USERNAME}`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard()
    });
    return;
  }

  if (text === '💸 Withdraw') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `💸 *ገንዘብ ማውጫ (Withdraw) — Zina Bingo*\n\n` +
        `🆔 የእርስዎ ID: \`${user.id}\`\n` +
        `💰 Main Balance: *${wallet.main.toFixed(2)}*\n` +
        `ለማውጣት ድጋፍን ያነጋግሩ፦ ${SUPPORT_USERNAME}`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard()
    });
    return;
  }

  if (text === '📞 Support') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `📞 *Zina Bingo Support*\n\nለማንኛውም ጥያቄ ወይም እገዛ፦ ${SUPPORT_USERNAME}`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard()
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
        `3️⃣ ቁጥሮች ሲጠሩ መስመር ወይም 4 ማዕዘን ሲሞላ *BINGO* ያሸንፋሉ።`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard()
    });
    return;
  }

  if (text === '🎁 Invite Friends') {
    const inviteLink = `https://t.me/ZinaBingoBot?start=ref_${user.id}`;
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `🎁 *ጓደኞችዎን ይጋብዙ (Zina Bingo)*\n\nየመጋበዣ ሊንክዎ፦\n${inviteLink}`,
      parse_mode: 'Markdown',
      reply_markup: getMainMenuKeyboard()
    });
    return;
  }

  await sendMainMenu(chatId, user.first_name || 'Player');
}

async function handleBotCallback(cb) {
  const user = cb.from;
  const chatId = cb.message?.chat?.id;
  if (!user || !chatId) return;

  if (cb.data === 'verify_channel') {
    const member = await isChannelMember(user.id);
    if (member) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '✅ ቻናሉን ተቀላቅለዋል! እንኳን ደህና መጡ።'
      });
      await sendMainMenu(chatId, user.first_name || 'Player');
    } else {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '❌ አሁንም ቻናሉን አልተቀላቀሉም። እባክዎ መጀመሪያ ይቀላቀሉ።',
        show_alert: true
      });
      await sendJoinPrompt(chatId);
    }
  }
}

async function startBotPolling() {
  if (!BOT_TOKEN) {
    console.warn('BOT_TOKEN is not set; Telegram bot polling skipped.');
    return;
  }

  let offset = 0;
  while (true) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=25&offset=${offset}`
      );
      const data = await res.json();
      if (data?.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleBotMessage(update.message);
          } else if (update.callback_query) {
            await handleBotCallback(update.callback_query);
          }
        }
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

    const template = boardTemplates.get(boardId);
    gameState.takenBoards.set(boardId, {
      socketId: socket.id,
      userId,
      username,
      board: template
    });

    io.emit('board:taken', {
      board: boardId,
      name: username,
      pool: calculatePrizePool()
    });
  });

  socket.on('board:release', ({ board } = {}) => {
    const boardId = Number(board);
    const existing = gameState.takenBoards.get(boardId);
    if (existing && existing.socketId === socket.id && gameState.phase === 'LOBBY') {
      gameState.takenBoards.delete(boardId);
      io.emit('board:released', { board: boardId, pool: calculatePrizePool() });
    }
  });

  socket.on('game:mark', () => {
    if (gameState.phase === 'PLAYING') {
      evaluateWinners();
    }
  });

  socket.on('game:auto', () => {});

  socket.on('wallet:topup_test', (payload = {}, ack) => {
    const amount = Number(payload.amount) || 100;
    const key = payload.user?.id ? String(payload.user.id) : getSocketKey(socket);
    const wallet = getWallet(key);
    wallet.main = Number((wallet.main + amount).toFixed(2));

    socket.emit('wallet:update', wallet);
    if (typeof ack === 'function') {
      ack({ wallet });
    }
  });

  socket.on('disconnect', () => {
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
});

server.listen(PORT, () => {
  console.log(`Bingo server running on port ${PORT}`);
  startLobby();
  startBotPolling();
});
