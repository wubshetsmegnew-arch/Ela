const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const HOUSE_COMMISSION = 0.20;
const LOBBY_SECONDS = 30;
const CALL_INTERVAL_MS = 2500;
const TOTAL_BOARDS = 600;

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

function checkWinPattern(grid, calledSet) {
  const isMarked = (r, c) => {
    const val = grid[r][c];
    return val === 'FREE' || calledSet.has(val);
  };

  for (let r = 0; r < 5; r++) {
    if ([0, 1, 2, 3, 4].every((c) => isMarked(r, c))) {
      return { pattern: `Horizontal (Row ${r + 1})`, line: { type: 'row', index: r } };
    }
  }

  for (let c = 0; c < 5; c++) {
    if ([0, 1, 2, 3, 4].every((r) => isMarked(r, c))) {
      return { pattern: `Vertical (Col ${c + 1})`, line: { type: 'col', index: c } };
    }
  }

  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, i))) {
    return { pattern: 'Diagonal (Top-Left to Bottom-Right)', line: { type: 'diag', index: 0 } };
  }

  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, 4 - i))) {
    return { pattern: 'Diagonal (Top-Right to Bottom-Left)', line: { type: 'diag', index: 1 } };
  }

  if (isMarked(0, 0) && isMarked(0, 4) && isMarked(4, 0) && isMarked(4, 4)) {
    return { pattern: '4-Corners', line: { type: 'corners', index: 0 } };
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
    gcode: `G-${gameState.roundNumber}`,
    pool: calculatePrizePool(),
    players: new Set([...gameState.takenBoards.values()].map((b) => b.socketId)).size,
    wallet: getWallet(key)
  });
}

function evaluateWinners() {
  const calledSet = new Set(gameState.calledNumbers);
  const foundWinners = [];

  for (const [boardId, player] of gameState.takenBoards.entries()) {
    const winInfo = checkWinPattern(player.board.grid, calledSet);
    if (winInfo) {
      foundWinners.push({
        socketId: player.socketId,
        userId: player.userId,
        name: player.username,
        board: boardId,
        pattern: winInfo.pattern,
        line: winInfo.line
      });
    }
  }

  if (foundWinners.length > 0) {
    clearInterval(drawTimer);
    drawTimer = null;
    gameState.phase = 'FINISHED';

    const totalPrize = calculatePrizePool();
    const splitAmount = Number((totalPrize / foundWinners.length).toFixed(2));

    const winnersPayload = foundWinners.map((w) => ({
      board: w.board,
      name: w.name,
      userId: w.userId,
      pattern: w.pattern,
      line: w.line,
      prize: splitAmount
    }));

    for (const w of foundWinners) {
      const wKey = w.userId || w.socketId;
      const wallet = getWallet(wKey);
      wallet.main = Number((wallet.main + splitAmount).toFixed(2));
      io.to(w.socketId).emit('wallet:update', wallet);
    }

    io.emit('game:win', {
      winners: winnersPayload,
      prize: splitAmount,
      pool: totalPrize,
      called: gameState.calledNumbers,
      t: 8
    });

    setTimeout(() => {
      startLobby();
    }, 8000);
  }
}

function startDrawing() {
  gameState.phase = 'PLAYING';
  gameState.winners = [];
  gameState.prizePool = calculatePrizePool();
  resetPool();

  io.emit('game:start', {
    gid: gameState.gameId,
    gcode: `G-${gameState.roundNumber}`,
    pool: gameState.prizePool,
    players: new Set([...gameState.takenBoards.values()].map((b) => b.socketId)).size
  });

  drawTimer = setInterval(() => {
    if (gameState.availableNumbers.length === 0) {
      clearInterval(drawTimer);
      drawTimer = null;
      gameState.phase = 'FINISHED';
      io.emit('game:win', {
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
      gcode: `G-${gameState.roundNumber}`,
      pool: calculatePrizePool(),
      players: new Set([...gameState.takenBoards.values()].map((b) => b.socketId)).size
    });

    if (gameState.countdown <= 0) {
      clearInterval(lobbyTimer);
      lobbyTimer = null;
      gameState.roundNumber += 1;
      startDrawing();
    }
  }, 1000);
}

app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    service: '75-Ball Bingo Multiplayer Backend',
    phase: gameState.phase,
    countdown: gameState.countdown,
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
        gcode: `G-${gameState.roundNumber}`,
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
        gcode: `G-${gameState.roundNumber}`,
        pool: calculatePrizePool(),
        players: new Set([...gameState.takenBoards.values()].map((b) => b.socketId)).size
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Bingo server running on port ${PORT}`);
  startLobby();
});
