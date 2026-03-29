const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
      luckyCount: p.luckyCount,
    };
  }
  return {
    id: room.id,
    settings: room.settings,
    gameState: room.gameState,
    players,
    luckySquares: room.luckySquares,
    finishedPlayers: room.finishedPlayers,
    roundNumber: room.roundNumber,
    questionCount: room.questions.length,
    usedCount: room.usedQuestionIds.size,
  };
}

// ── REST API ─────────────────────────────────────────────────────────────────

app.post('/api/rooms', (req, res) => {
  const { adminPassword, boardSize, timeLimit, luckySquares } = req.body;
  if (!adminPassword) return res.status(400).json({ error: '需要管理员密码' });
  const roomId = genId();
  rooms[roomId] = {
    id: roomId,
    adminPasswordHash: hash(adminPassword),
    settings: {
      boardSize: Math.max(10, Math.min(200, parseInt(boardSize) || 30)),
      timeLimit: Math.max(5, Math.min(300, parseInt(timeLimit) || 30)),
    },
    questions: [],
    luckySquares: [],
    players: {},
    adminSocketId: null,
    gameState: 'waiting',
    currentQuestion: null,
    finishedPlayers: [],
    roundNumber: 0,
    usedQuestionIds: new Set(),
  };
  if (Array.isArray(luckySquares)) {
    rooms[roomId].luckySquares = luckySquares.map(Number).filter(n => n > 0);
  }
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
    luckySquares: room.luckySquares,
    gameState: room.gameState,
    playerCount: Object.keys(room.players).length,
    usedCount: room.usedQuestionIds.size,
  });
});

app.put('/api/rooms/:id/settings', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (hash(req.body.adminPassword || '') !== room.adminPasswordHash)
    return res.status(401).json({ error: '密码错误' });
  const { boardSize, timeLimit } = req.body;
  if (boardSize !== undefined) room.settings.boardSize = Math.max(10, Math.min(200, parseInt(boardSize)));
  if (timeLimit !== undefined) room.settings.timeLimit = Math.max(5, Math.min(300, parseInt(timeLimit)));
  io.to('room:' + room.id).emit('state:update', publicState(room));
  res.json({ ok: true, settings: room.settings });
});

app.post('/api/rooms/:id/questions', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (hash(req.body.adminPassword || '') !== room.adminPasswordHash)
    return res.status(401).json({ error: '密码错误' });
  const { text, options, correctIndices } = req.body;
  if (!text || !Array.isArray(options) || options.length < 2 || options.length > 4)
    return res.status(400).json({ error: '题目格式错误（需2-4个选项）' });
  if (!Array.isArray(correctIndices) || correctIndices.length === 0)
    return res.status(400).json({ error: '需要至少一个正确答案' });
  const sorted = [...new Set(correctIndices.map(Number))].sort();
  if (sorted.some(ci => ci < 0 || ci >= options.length))
    return res.status(400).json({ error: '正确答案索引无效' });
  room.questions.push({
    id: Date.now().toString() + Math.random().toString(36).substr(2, 4),
    text: text.trim(),
    options: options.map(o => String(o).trim()),
    correctIndices: sorted,
  });
  res.json({ ok: true, questions: room.questions });
});

app.delete('/api/rooms/:id/questions/:qid', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (hash(req.body.adminPassword || '') !== room.adminPasswordHash)
    return res.status(401).json({ error: '密码错误' });
  room.questions = room.questions.filter(q => q.id !== req.params.qid);
  room.usedQuestionIds.delete(req.params.qid);
  res.json({ ok: true, questions: room.questions });
});

app.put('/api/rooms/:id/lucky-squares', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (hash(req.body.adminPassword || '') !== room.adminPasswordHash)
    return res.status(401).json({ error: '密码错误' });
  const squares = (req.body.squares || [])
    .map(n => parseInt(n))
    .filter(n => n > 0 && n < room.settings.boardSize);
  room.luckySquares = [...new Set(squares)];
  io.to('room:' + room.id).emit('state:update', publicState(room));
  res.json({ ok: true, luckySquares: room.luckySquares });
});

// Question import endpoint
app.post('/api/rooms/:id/import', upload.single('file'), async (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (hash(req.body.adminPassword || '') !== room.adminPasswordHash)
    return res.status(401).json({ error: '密码错误' });
  if (!req.file) return res.status(400).json({ error: '没有上传文件' });

  try {
    let text = '';
    const mime = req.file.mimetype;
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (ext === '.pdf' || mime === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } else if (ext === '.docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    } else {
      text = req.file.buffer.toString('utf-8');
    }

    const imported = parseQuestionsFromText(text);
    if (imported.length === 0) return res.status(400).json({ error: '未找到可解析的题目，请检查格式' });

    for (const q of imported) {
      room.questions.push(q);
    }

    res.json({ ok: true, imported: imported.length, questions: room.questions });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: '文件解析失败: ' + err.message });
  }
});

function parseQuestionsFromText(text) {
  const questions = [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let current = null;

  for (const line of lines) {
    const qMatch = line.match(/^Q:\s*(.+)/i);
    const optMatch = line.match(/^([A-D])\.\s*(.+)/i);

    if (qMatch) {
      if (current && current.options.length >= 2) {
        const correctIndices = [];
        current.options.forEach((opt, i) => {
          if (opt.correct) correctIndices.push(i);
        });
        if (correctIndices.length > 0) {
          questions.push({
            id: Date.now().toString() + Math.random().toString(36).substr(2, 4),
            text: current.text,
            options: current.options.map(o => o.text),
            correctIndices,
          });
        }
      }
      current = { text: qMatch[1].trim(), options: [] };
    } else if (optMatch && current) {
      const raw = optMatch[2];
      const correct = raw.endsWith('*');
      const text2 = correct ? raw.slice(0, -1).trim() : raw.trim();
      current.options.push({ text: text2, correct });
    }
  }

  // Push last question
  if (current && current.options.length >= 2) {
    const correctIndices = [];
    current.options.forEach((opt, i) => {
      if (opt.correct) correctIndices.push(i);
    });
    if (correctIndices.length > 0) {
      questions.push({
        id: Date.now().toString() + Math.random().toString(36).substr(2, 4),
        text: current.text,
        options: current.options.map(o => o.text),
        correctIndices,
      });
    }
  }

  return questions;
}

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────

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

  socket.on('player:join', ({ roomId, uid, password }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('join:error', '房间不存在');
    if (!uid || !password) return socket.emit('join:error', '请输入UID和密码');

    const pwHash = hash(password);
    const existing = room.players[uid];

    if (existing) {
      if (existing.passwordHash !== pwHash) return socket.emit('join:error', '密码错误（与首次加入不一致）');
      existing.socketId = socket.id;
      existing.connected = true;
    } else {
      if (room.gameState !== 'waiting') return socket.emit('join:error', '游戏已开始，无法加入');
      room.players[uid] = {
        id: uid,
        passwordHash: pwHash,
        socketId: socket.id,
        position: 0,
        finished: false,
        finishOrder: null,
        connected: true,
        luckyCount: 0,
        answeredThisRound: false,
      };
    }

    socket.data.playerId = uid;
    socket.data.roomId = roomId;
    socket.join('room:' + roomId);

    socket.emit('player:joined', { uid, state: publicState(room) });

    // Rejoin mid-game: send current question if active
    if (room.gameState === 'question' && room.currentQuestion) {
      const elapsed = Math.floor((Date.now() - room.currentQuestion.startTime) / 1000);
      const remaining = Math.max(0, room.settings.timeLimit - elapsed);
      socket.emit('game:question', {
        question: {
          id: room.currentQuestion.question.id,
          text: room.currentQuestion.question.text,
          options: room.currentQuestion.question.options,
          optionCount: room.currentQuestion.question.options.length,
        },
        timeLimit: room.settings.timeLimit,
        remaining,
        roundNumber: room.roundNumber,
        alreadyAnswered: room.players[uid]?.answeredThisRound || false,
      });
    }

    if (room.gameState === 'ended') {
      socket.emit('game:ended', buildLeaderboard(room));
    }

    io.to('admin:' + roomId).emit('admin:state-update', publicState(room));
  });

  socket.on('player:answer', ({ answers }) => {
    const { roomId, playerId } = socket.data;
    if (!roomId || !playerId) return;
    const room = rooms[roomId];
    if (!room || room.gameState !== 'question' || !room.currentQuestion) return;
    const player = room.players[playerId];
    if (!player || player.finished || player.answeredThisRound) return;

    const sortedAnswer = Array.isArray(answers)
      ? [...new Set(answers.map(Number))].sort()
      : [];

    player.answeredThisRound = true;
    room.currentQuestion.answers[playerId] = sortedAnswer;

    socket.emit('answer:received');

    // Check if all active players answered
    const activePlayers = Object.values(room.players).filter(p => !p.finished && p.connected);
    if (activePlayers.every(p => p.answeredThisRound)) {
      clearTimeout(room.currentQuestion.timerId);
      resolveQuestion(room);
    }
  });

  socket.on('admin:start-game', () => {
    const room = rooms[socket.data.roomId];
    if (!room || !socket.data.isAdmin) return;
    if (room.gameState !== 'waiting') return socket.emit('error', '游戏已经开始');
    if (Object.keys(room.players).length < 1) return socket.emit('error', '没有玩家加入');
    if (room.questions.length < 1) return socket.emit('error', '题库为空，请先添加题目');

    room.gameState = 'ready';
    io.to('room:' + room.id).emit('game:started', publicState(room));
    io.to('admin:' + room.id).emit('admin:state-update', publicState(room));
  });

  socket.on('admin:next-question', () => {
    const room = rooms[socket.data.roomId];
    if (!room || !socket.data.isAdmin) return;
    if (room.gameState !== 'ready') return socket.emit('error', '状态不对，无法发题');
    startQuestion(room);
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

// ── GAME LOGIC ─────────────────────────────────────────────────────────────────

function startQuestion(room) {
  if (room.gameState !== 'ready') return;

  const unused = room.questions.filter(q => !room.usedQuestionIds.has(q.id));
  if (unused.length === 0) {
    io.to('admin:' + room.id).emit('admin:no-questions', { message: '题库已用完' });
    return;
  }

  const q = unused[Math.floor(Math.random() * unused.length)];
  room.usedQuestionIds.add(q.id);
  room.roundNumber++;

  for (const p of Object.values(room.players)) p.answeredThisRound = false;

  room.gameState = 'question';
  room.currentQuestion = {
    question: q,
    answers: {},
    startTime: Date.now(),
    timerId: null,
  };

  const payload = {
    question: {
      id: q.id,
      text: q.text,
      options: q.options,
      optionCount: q.options.length,
    },
    timeLimit: room.settings.timeLimit,
    remaining: room.settings.timeLimit,
    roundNumber: room.roundNumber,
  };

  io.to('room:' + room.id).emit('game:question', { ...payload, alreadyAnswered: false });
  io.to('admin:' + room.id).emit('admin:state-update', publicState(room));

  room.currentQuestion.timerId = setTimeout(() => {
    if (room.gameState === 'question') resolveQuestion(room);
  }, room.settings.timeLimit * 1000);
}

function resolveQuestion(room) {
  if (!room.currentQuestion || room.gameState !== 'question') return;

  room.gameState = 'resolving';
  const q = room.currentQuestion.question;
  const results = {};

  for (const player of Object.values(room.players)) {
    if (player.finished) continue;

    const oldPos = player.position;
    const submittedAnswers = room.currentQuestion.answers[player.id] || [];
    const correct = arraysEqual(submittedAnswers, q.correctIndices);

    let dice = null;
    let newPos = oldPos;

    if (correct) {
      dice = roll();
      newPos = Math.min(oldPos + dice, room.settings.boardSize);
    }
    // Wrong or timeout = stay (no backward movement)

    player.position = newPos;

    let hitLucky = false;
    if (newPos !== oldPos && room.luckySquares.includes(newPos)) {
      player.luckyCount++;
      hitLucky = true;
    }

    let justFinished = false;
    if (newPos >= room.settings.boardSize && !player.finished) {
      player.finished = true;
      player.finishOrder = room.finishedPlayers.length + 1;
      room.finishedPlayers.push(player.id);
      justFinished = true;
    }

    results[player.id] = {
      answered: player.answeredThisRound,
      correct,
      dice,
      oldPos,
      newPos,
      hitLucky,
      justFinished,
      submittedAnswers,
    };
  }

  room.currentQuestion = null;
  room.gameState = 'ready';

  const unusedLeft = room.questions.filter(q2 => !room.usedQuestionIds.has(q2.id)).length;

  const payload = {
    roundNumber: room.roundNumber,
    correctIndices: q.correctIndices,
    correctAnswers: q.correctIndices.map(i => q.options[i]),
    questionText: q.text,
    questionOptions: q.options,
    results,
    state: publicState(room),
    unusedLeft,
  };

  io.to('room:' + room.id).emit('game:resolved', payload);
  io.to('admin:' + room.id).emit('admin:state-update', publicState(room));
}

function endGame(room) {
  if (room.currentQuestion) {
    clearTimeout(room.currentQuestion.timerId);
    room.currentQuestion = null;
  }
  room.gameState = 'ended';
  io.to('room:' + room.id).emit('game:ended', buildLeaderboard(room));
  io.to('admin:' + room.id).emit('admin:state-update', publicState(room));
}

function buildLeaderboard(room) {
  const finished = room.finishedPlayers.map((id, i) => ({
    id,
    rank: i + 1,
    position: room.settings.boardSize,
    finished: true,
    luckyCount: room.players[id]?.luckyCount || 0,
  }));
  const unfinished = Object.values(room.players)
    .filter(p => !p.finished)
    .sort((a, b) => b.position - a.position)
    .map((p, i) => ({
      id: p.id,
      rank: finished.length + i + 1,
      position: p.position,
      finished: false,
      luckyCount: p.luckyCount,
    }));
  return {
    leaderboard: [...finished, ...unfinished],
    luckyPlayers: Object.values(room.players)
      .filter(p => p.luckyCount > 0)
      .sort((a, b) => b.luckyCount - a.luckyCount)
      .map(p => ({ id: p.id, luckyCount: p.luckyCount })),
  };
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Trivia Board Game v2 running: http://localhost:${PORT}`));
