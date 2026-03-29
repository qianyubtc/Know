const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const rooms = {};

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const roll = () => Math.floor(Math.random() * 6) + 1;
const genId = () => Math.random().toString(36).substr(2, 6).toUpperCase();

function publicState(room) {
  const players = {};
  for (const [id, p] of Object.entries(room.players)) {
    players[id] = {
      id: p.id,
      position: p.position,
      finished: p.finished,
      finishOrder: p.finishOrder,
      connected: p.connected,
      surpriseCount: p.surpriseCount,
    };
  }
  return {
    id: room.id,
    settings: room.settings,
    gameState: room.gameState,
    players,
    surpriseSquares: room.surpriseSquares,
    finishedPlayers: room.finishedPlayers,
    roundNumber: room.roundNumber,
  };
}

// ── REST API ────────────────────────────────────────────────────────────────

app.post('/api/rooms', (req, res) => {
  const { adminPassword, boardSize, timeLimit, minPlayersToEnd } = req.body;
  if (!adminPassword) return res.status(400).json({ error: '需要管理员密码' });
  const roomId = genId();
  rooms[roomId] = {
    id: roomId,
    adminPasswordHash: hash(adminPassword),
    settings: {
      boardSize: Math.max(10, Math.min(100, parseInt(boardSize) || 30)),
      timeLimit: Math.max(5, Math.min(120, parseInt(timeLimit) || 30)),
      minPlayersToEnd: Math.max(1, parseInt(minPlayersToEnd) || 3),
    },
    questions: [],
    surpriseSquares: [],
    players: {},
    adminSocketId: null,
    gameState: 'waiting',
    currentRound: null,
    finishedPlayers: [],
    roundNumber: 0,
  };
  res.json({ roomId });
});

app.post('/api/rooms/:id/verify', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (hash(req.body.password || '') !== room.adminPasswordHash)
    return res.status(401).json({ error: '密码错误' });
  res.json({
    settings: room.settings,
    questions: room.questions,
    surpriseSquares: room.surpriseSquares,
    gameState: room.gameState,
    playerCount: Object.keys(room.players).length,
  });
});

app.put('/api/rooms/:id/settings', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (hash(req.body.adminPassword || '') !== room.adminPasswordHash)
    return res.status(401).json({ error: '密码错误' });
  if (room.gameState !== 'waiting')
    return res.status(400).json({ error: '游戏已开始，无法修改设置' });
  const { boardSize, timeLimit, minPlayersToEnd } = req.body;
  if (boardSize) room.settings.boardSize = Math.max(10, Math.min(100, parseInt(boardSize)));
  if (timeLimit) room.settings.timeLimit = Math.max(5, Math.min(120, parseInt(timeLimit)));
  if (minPlayersToEnd) room.settings.minPlayersToEnd = Math.max(1, parseInt(minPlayersToEnd));
  res.json({ ok: true, settings: room.settings });
});

app.post('/api/rooms/:id/questions', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (hash(req.body.adminPassword || '') !== room.adminPasswordHash)
    return res.status(401).json({ error: '密码错误' });
  const { text, options, correctIndex } = req.body;
  if (!text || !Array.isArray(options) || options.length < 2 || options.length > 4)
    return res.status(400).json({ error: '题目格式错误（需2-4个选项）' });
  const ci = parseInt(correctIndex);
  if (isNaN(ci) || ci < 0 || ci >= options.length)
    return res.status(400).json({ error: '正确答案索引无效' });
  room.questions.push({
    id: Date.now().toString() + Math.random().toString(36).substr(2, 4),
    text: text.trim(),
    options: options.map(o => String(o).trim()),
    correctIndex: ci,
  });
  res.json({ ok: true, questions: room.questions });
});

app.delete('/api/rooms/:id/questions/:qid', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (hash(req.body.adminPassword || '') !== room.adminPasswordHash)
    return res.status(401).json({ error: '密码错误' });
  room.questions = room.questions.filter(q => q.id !== req.params.qid);
  res.json({ ok: true, questions: room.questions });
});

app.put('/api/rooms/:id/surprise-squares', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (hash(req.body.adminPassword || '') !== room.adminPasswordHash)
    return res.status(401).json({ error: '密码错误' });
  const squares = (req.body.squares || [])
    .map(n => parseInt(n))
    .filter(n => n > 0 && n < room.settings.boardSize);
  room.surpriseSquares = [...new Set(squares)];
  res.json({ ok: true, surpriseSquares: room.surpriseSquares });
});

// ── SOCKET.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('admin:join', ({ roomId, password }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', '房间不存在');
    if (hash(password || '') !== room.adminPasswordHash)
      return socket.emit('error', '密码错误');
    room.adminSocketId = socket.id;
    socket.join('room:' + roomId);
    socket.join('admin:' + roomId);
    socket.data.roomId = roomId;
    socket.data.isAdmin = true;
    socket.emit('admin:joined', publicState(room));
  });

  socket.on('player:join', ({ roomId, playerId, password }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('join:error', '房间不存在');
    if (!playerId || !password) return socket.emit('join:error', '请输入ID和密码');

    const pwHash = hash(password);
    const existing = room.players[playerId];

    if (existing) {
      if (existing.passwordHash !== pwHash) return socket.emit('join:error', '密码错误');
      existing.socketId = socket.id;
      existing.connected = true;
    } else {
      if (room.gameState !== 'waiting') return socket.emit('join:error', '游戏已开始，无法加入');
      room.players[playerId] = {
        id: playerId,
        passwordHash: pwHash,
        socketId: socket.id,
        position: 0,
        finished: false,
        finishOrder: null,
        connected: true,
        surpriseCount: 0,
        answeredThisRound: false,
      };
    }

    socket.data.playerId = playerId;
    socket.data.roomId = roomId;
    socket.join('room:' + roomId);

    socket.emit('player:joined', { playerId, state: publicState(room) });

    if (room.gameState === 'playing' && room.currentRound) {
      const elapsed = Math.floor((Date.now() - room.currentRound.startTime) / 1000);
      const remaining = room.settings.timeLimit - elapsed;
      if (remaining > 0) {
        socket.emit('game:question', {
          question: {
            id: room.currentRound.question.id,
            text: room.currentRound.question.text,
            options: room.currentRound.question.options,
          },
          timeLimit: room.settings.timeLimit,
          remaining,
          roundNumber: room.roundNumber,
          alreadyAnswered: room.players[playerId]?.answeredThisRound || false,
        });
      }
    }

    if (room.gameState === 'ended') {
      socket.emit('game:ended', buildLeaderboard(room));
    }

    io.to('admin:' + roomId).emit('admin:state-update', publicState(room));
  });

  socket.on('player:answer', ({ answerIndex }) => {
    const { roomId, playerId } = socket.data;
    if (!roomId || !playerId) return;
    const room = rooms[roomId];
    if (!room || room.gameState !== 'playing' || !room.currentRound) return;
    const player = room.players[playerId];
    if (!player || player.finished || player.answeredThisRound) return;

    player.answeredThisRound = true;
    room.currentRound.answers[playerId] = parseInt(answerIndex);

    const activePlayers = Object.values(room.players).filter(p => !p.finished);
    if (activePlayers.every(p => p.answeredThisRound)) {
      clearTimeout(room.currentRound.timerId);
      resolveRound(room);
    }
  });

  socket.on('admin:start-game', () => {
    const room = rooms[socket.data.roomId];
    if (!room || !socket.data.isAdmin) return;
    if (room.gameState !== 'waiting') return socket.emit('error', '游戏已经开始');
    if (Object.keys(room.players).length < 1) return socket.emit('error', '没有玩家加入');
    if (room.questions.length < 1) return socket.emit('error', '题库为空，请先添加题目');

    room.gameState = 'playing';
    io.to('room:' + room.id).emit('game:started', publicState(room));
    setTimeout(() => startRound(room), 2000);
  });

  socket.on('admin:end-game', () => {
    const room = rooms[socket.data.roomId];
    if (!room || !socket.data.isAdmin) return;
    endGame(room);
  });

  socket.on('disconnect', () => {
    const { roomId, playerId, isAdmin } = socket.data;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    if (isAdmin) {
      room.adminSocketId = null;
    } else if (playerId && room.players[playerId]) {
      room.players[playerId].connected = false;
      io.to('admin:' + roomId).emit('admin:state-update', publicState(room));
    }
  });
});

// ── GAME LOGIC ──────────────────────────────────────────────────────────────

function startRound(room) {
  if (room.gameState !== 'playing') return;

  const activePlayers = Object.values(room.players).filter(p => !p.finished);
  if (activePlayers.length === 0) { endGame(room); return; }

  const q = room.questions[Math.floor(Math.random() * room.questions.length)];
  room.roundNumber++;

  for (const p of Object.values(room.players)) p.answeredThisRound = false;

  room.currentRound = {
    question: q,
    answers: {},
    startTime: Date.now(),
    timerId: null,
  };

  io.to('room:' + room.id).emit('game:question', {
    question: { id: q.id, text: q.text, options: q.options },
    timeLimit: room.settings.timeLimit,
    remaining: room.settings.timeLimit,
    roundNumber: room.roundNumber,
    alreadyAnswered: false,
  });

  room.currentRound.timerId = setTimeout(() => resolveRound(room), room.settings.timeLimit * 1000);
}

function resolveRound(room) {
  if (!room.currentRound) return;

  const q = room.currentRound.question;
  const results = {};

  for (const player of Object.values(room.players)) {
    if (player.finished) continue;

    const oldPos = player.position;
    const answered = player.answeredThisRound;
    const correct = answered && room.currentRound.answers[player.id] === q.correctIndex;

    let dice = null;
    let newPos = oldPos;

    if (answered) {
      dice = roll();
      newPos = correct
        ? Math.min(oldPos + dice, room.settings.boardSize)
        : Math.max(oldPos - dice, 0);
    }

    player.position = newPos;

    let hitSurprise = null;
    if (newPos !== oldPos && newPos > 0 && newPos < room.settings.boardSize
        && room.surpriseSquares.includes(newPos)) {
      player.surpriseCount++;
      hitSurprise = newPos;
    }

    let justFinished = false;
    if (newPos >= room.settings.boardSize && !player.finished) {
      player.finished = true;
      player.finishOrder = room.finishedPlayers.length + 1;
      room.finishedPlayers.push(player.id);
      justFinished = true;
    }

    results[player.id] = { answered, correct, dice, oldPos, newPos, hitSurprise, justFinished };
  }

  room.currentRound = null;

  io.to('room:' + room.id).emit('game:round-result', {
    roundNumber: room.roundNumber,
    correctIndex: q.correctIndex,
    correctAnswer: q.options[q.correctIndex],
    results,
    state: publicState(room),
  });

  if (room.finishedPlayers.length >= room.settings.minPlayersToEnd) {
    io.to('admin:' + room.id).emit('admin:can-end', {
      finishedCount: room.finishedPlayers.length,
    });
  }

  setTimeout(() => startRound(room), 4000);
}

function endGame(room) {
  if (room.currentRound) {
    clearTimeout(room.currentRound.timerId);
    room.currentRound = null;
  }
  room.gameState = 'ended';
  io.to('room:' + room.id).emit('game:ended', buildLeaderboard(room));
}

function buildLeaderboard(room) {
  const finished = room.finishedPlayers.map((id, i) => ({
    id, rank: i + 1, position: room.settings.boardSize,
    finished: true, surpriseCount: room.players[id]?.surpriseCount || 0,
  }));
  const unfinished = Object.values(room.players)
    .filter(p => !p.finished)
    .sort((a, b) => b.position - a.position)
    .map((p, i) => ({
      id: p.id, rank: finished.length + i + 1, position: p.position,
      finished: false, surpriseCount: p.surpriseCount,
    }));
  return { leaderboard: [...finished, ...unfinished] };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
