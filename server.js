const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const HOUSE_COMMISSION = 0.20; // 20% house commission
const LOBBY_SECONDS = 30; // 30s lobby countdown
const CALL_INTERVAL_MS = 2500; // 2.5s number call interval

// Standard 75-ball Bingo column ranges: B(1-15), I(16-30), N(31-45), G(46-60), O(61-75)
function generateBoard(boardId) {
  const ranges = [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75]
  ];
  // 5x5 grid stored column-major or row-major; here grid[row][col]
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
      if (row === 2 && col === 2) {
        grid[row][col] = 'FREE';
      } else {
        grid[row][col] = pool[row];
      }
    }
  }

  return { boardId, grid };
}

// Pre-generate pool of boards (e.g., 100 boards)
const TOTAL_BOARDS = 100;
const boardTemplates = new Map();
for (let i = 1; i <= TOTAL_BOARDS; i++) {
  boardTemplates.set(i, generateBoard(i));
}

let gameState = {
  phase: 'LOBBY', // 'LOBBY' | 'PLAYING' | 'FINISHED'
  countdown: LOBBY_SECONDS,
  stake: 10, // Default stake (can be updated per session/room)
  takenBoards: new Map(), // boardId -> { socketId, username, board }
  calledNumbers: [],
  availableNumbers: [],
  winners: [],
  prizePool: 0
};

let lobbyTimer = null;
let drawTimer = null;

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

function getTakenBoardsSummary() {
  const summary = {};
  for (const [boardId, info] of gameState.takenBoards.entries()) {
    summary[boardId] = {
      username: info.username,
      socketId: info.socketId
    };
  }
  return summary;
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

  // Horizontal
  for (let r = 0; r < 5; r++) {
    if ([0, 1, 2, 3, 4].every((c) => isMarked(r, c))) {
      return `Horizontal (Row ${r + 1})`;
    }
  }

  // Vertical
  for (let c = 0; c < 5; c++) {
    if ([0, 1, 2, 3, 4].every((r) => isMarked(r, c))) {
      return `Vertical (Col ${c + 1})`;
    }
  }

  // Main Diagonal
  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, i))) {
    return 'Diagonal (Top-Left to Bottom-Right)';
  }

  // Anti-Diagonal
  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, 4 - i))) {
    return 'Diagonal (Top-Right to Bottom-Left)';
  }

  // 4-Corners
  if (
    isMarked(0, 0) &&
    isMarked(0, 4) &&
    isMarked(4, 0) &&
    isMarked(4, 4)
  ) {
    return '4-Corners';
  }

  return null;
}

function evaluateWinners() {
  const calledSet = new Set(gameState.calledNumbers);
  const foundWinners = [];

  for (const [boardId, player] of gameState.takenBoards.entries()) {
    const pattern = checkWinPattern(player.board.grid, calledSet);
    if (pattern) {
      foundWinners.push({
        socketId: player.socketId,
        username: player.username,
        boardId,
        pattern
      });
    }
  }

  if (foundWinners.length > 0) {
    clearInterval(drawTimer);
    drawTimer = null;
    gameState.phase = 'FINISHED';
    const totalPrize = calculatePrizePool();
    const splitAmount = Number((totalPrize / foundWinners.length).toFixed(2));

    gameState.winners = foundWinners.map((w) => ({
      ...w,
      prize: splitAmount
    }));

    io.emit('game_over', {
      winners: gameState.winners,
      prizePool: totalPrize,
      splitAmount,
      calledNumbers: gameState.calledNumbers
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

  io.emit('game_started', {
    prizePool: gameState.prizePool,
    totalBoards: gameState.takenBoards.size
  });

  drawTimer = setInterval(() => {
    if (gameState.availableNumbers.length === 0) {
      clearInterval(drawTimer);
      drawTimer = null;
      gameState.phase = 'FINISHED';
      io.emit('game_over', {
        winners: [],
        prizePool: gameState.prizePool,
        splitAmount: 0,
        calledNumbers: gameState.calledNumbers,
        message: 'All 75 numbers called with no winner.'
      });
      setTimeout(() => startLobby(), 6000);
      return;
    }

    const nextNumber = gameState.availableNumbers.shift();
    gameState.calledNumbers.push(nextNumber);

    io.emit('number_called', {
      number: nextNumber,
      calledNumbers: gameState.calledNumbers,
      count: gameState.calledNumbers.length
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
  gameState.takenBoards.clear();
  gameState.calledNumbers = [];
  gameState.availableNumbers = [];
  gameState.winners = [];
  gameState.prizePool = 0;

  io.emit('lobby_reset', {
    countdown: gameState.countdown,
    stake: gameState.stake,
    totalBoards: TOTAL_BOARDS
  });

  lobbyTimer = setInterval(() => {
    gameState.countdown -= 1;
    io.emit('countdown_tick', { countdown: gameState.countdown });

    if (gameState.countdown <= 0) {
      clearInterval(lobbyTimer);
      lobbyTimer = null;
      startDrawing();
    }
  }, 1000);
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: '75-Ball Bingo Multiplayer Backend',
    phase: gameState.phase,
    countdown: gameState.countdown,
    takenBoardsCount: gameState.takenBoards.size
  });
});

io.on('connection', (socket) => {
  socket.emit('sync_state', {
    phase: gameState.phase,
    countdown: gameState.countdown,
    stake: gameState.stake,
    totalBoards: TOTAL_BOARDS,
    takenBoards: getTakenBoardsSummary(),
    calledNumbers: gameState.calledNumbers,
    prizePool: calculatePrizePool(),
    winners: gameState.winners
  });

  socket.on('select_boards', ({ boardIds = [], username = 'Player' }) => {
    if (gameState.phase !== 'LOBBY') {
      socket.emit('selection_error', { message: 'Game already in progress.' });
      return;
    }

    // Support 1 or 2 boards per player
    const requested = [...new Set(boardIds)].slice(0, 2);
    const existingCount = [...gameState.takenBoards.values()].filter(
      (b) => b.socketId === socket.id
    ).length;

    if (existingCount + requested.length > 2) {
      socket.emit('selection_error', { message: 'Maximum 2 boards allowed.' });
      return;
    }

    const assigned = [];
    for (const id of requested) {
      if (!boardTemplates.has(id)) continue;
      if (gameState.takenBoards.has(id)) {
        socket.emit('selection_error', { message: `Board #${id} is already taken.` });
        continue;
      }

      const template = boardTemplates.get(id);
      gameState.takenBoards.set(id, {
        socketId: socket.id,
        username,
        board: template
      });
      assigned.push(template);
    }

    if (assigned.length > 0) {
      socket.emit('boards_assigned', { boards: assigned });
      io.emit('boards_updated', {
        takenBoards: getTakenBoardsSummary(),
        prizePool: calculatePrizePool()
      });
    }
  });

  socket.on('claim_bingo', () => {
    if (gameState.phase === 'PLAYING') {
      evaluateWinners();
    }
  });

  socket.on('disconnect', () => {
    let changed = false;
    for (const [boardId, info] of gameState.takenBoards.entries()) {
      if (info.socketId === socket.id && gameState.phase === 'LOBBY') {
        gameState.takenBoards.delete(boardId);
        changed = true;
      }
    }
    if (changed) {
      io.emit('boards_updated', {
        takenBoards: getTakenBoardsSummary(),
        prizePool: calculatePrizePool()
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Bingo server running on port ${PORT}`);
  startLobby();
});
