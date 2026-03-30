// Player client logic
const socket = io({ transports: ['websocket'], upgrade: false });

const state = {
  roomId: null,
  myUid: null,
  gameState: 'waiting',
  players: {},
  luckySquares: [],
  boardSize: 30,
  roundNumber: 0,
  selectedOptions: new Set(),
  answered: false,
  countdownInterval: null,
  timeLimit: 30,
  currentQuestion: null,
};

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

// ── DOM refs ─────────────────────────────────────────────────────────────────
const views = {
  join: document.getElementById('view-join'),
  waiting: document.getElementById('view-waiting'),
  game: document.getElementById('view-game'),
  gameover: document.getElementById('view-gameover'),
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  if (views[name]) views[name].classList.add('active');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 350);
  }, 3200);
}

// ── JOIN ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-join').addEventListener('click', () => {
  const roomId = document.getElementById('inp-room').value.trim().toUpperCase();
  const uid = document.getElementById('inp-uid').value.trim();
  const pw = document.getElementById('inp-pw').value.trim();
  const errEl = document.getElementById('join-error');
  errEl.classList.add('hidden');

  if (!roomId) { errEl.textContent = '请输入房间ID'; errEl.classList.remove('hidden'); return; }
  if (!uid) { errEl.textContent = '请输入Binance UID'; errEl.classList.remove('hidden'); return; }
  if (!/^\d{6}$/.test(pw)) { errEl.textContent = '密码必须是6位数字'; errEl.classList.remove('hidden'); return; }

  state.roomId = roomId;
  state.myUid = uid;
  document.getElementById('btn-join').disabled = true;
  socket.emit('player:join', { roomId, uid, password: pw });
});

document.getElementById('inp-pw').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

socket.on('join:error', (msg) => {
  const errEl = document.getElementById('join-error');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
  document.getElementById('btn-join').disabled = false;
});

socket.on('player:joined', ({ uid, state: s }) => {
  state.myUid = uid;
  applyState(s);
  if (s.gameState === 'waiting') {
    showView('waiting');
    renderWaiting(s);
  } else if (s.gameState === 'ended') {
    // handled by game:ended
  } else {
    showView('game');
    renderGame();
  }
  toast('成功加入房间 ' + state.roomId, 'success');
});

// ── STATE APPLICATION ─────────────────────────────────────────────────────────
function applyState(s) {
  state.players = s.players || {};
  state.luckySquares = s.luckySquares || [];
  state.boardSize = s.settings?.boardSize || 30;
  state.timeLimit = s.settings?.timeLimit || 30;
  state.gameState = s.gameState;
  state.roundNumber = s.roundNumber || 0;
}

// ── WAITING VIEW ──────────────────────────────────────────────────────────────
function renderWaiting(s) {
  document.getElementById('wait-room-info').textContent = '房间 ID: ' + state.roomId;
  document.getElementById('wait-uid-info').textContent = '你的UID: ' + state.myUid;
  const list = document.getElementById('wait-player-list');
  list.innerHTML = Object.values(s.players || {}).map(p => {
    const color = Board.playerColor(p.id);
    return `<div class="player-chip${p.connected ? '' : ' offline'}" style="background:${color}22;border-color:${color};">
      <div class="dot" style="background:${color};"></div>
      <span>${p.id}</span>
    </div>`;
  }).join('');
}

// ── GAME VIEW ─────────────────────────────────────────────────────────────────
function renderGame() {
  document.getElementById('game-room-badge').textContent = state.roomId;
  renderBoard();
  Board.renderMiniScoreboard('mini-scoreboard', state.players, state.boardSize, state.myUid);
}

function renderBoard() {
  Board.render('player-board', state.boardSize, state.luckySquares, state.players, state.myUid);
}

// ── SOCKET EVENTS ─────────────────────────────────────────────────────────────
socket.on('game:started', (s) => {
  applyState(s);
  showView('game');
  renderGame();
  toast('🎮 游戏开始!', 'success');
  showIdle();
});

socket.on('state:update', (s) => {
  applyState(s);
  if (state.gameState !== 'waiting') {
    renderBoard();
    Board.renderMiniScoreboard('mini-scoreboard', state.players, state.boardSize, state.myUid);
  } else {
    renderWaiting(s);
  }
});

socket.on('game:question', ({ question, timeLimit, remaining, roundNumber, alreadyAnswered }) => {
  state.currentQuestion = question;
  state.roundNumber = roundNumber;
  state.timeLimit = timeLimit;
  state.answered = alreadyAnswered || false;
  state.selectedOptions.clear();

  showView('game');
  showQuestionUI(question, timeLimit, remaining);
  document.getElementById('game-status-bar').textContent = `第 ${roundNumber} 题 / 倒计时 ${remaining}s`;
});

socket.on('answer:received', () => {
  state.answered = true;
  showAnsweredState();
});

socket.on('game:resolved', (data) => {
  applyState(data.state);
  stopCountdown();
  showResultUI(data);
  runResolutionAnimation(data);
});

socket.on('game:ended', (data) => {
  stopCountdown();
  applyState({ players: state.players, luckySquares: state.luckySquares, settings: { boardSize: state.boardSize, timeLimit: state.timeLimit }, gameState: 'ended', roundNumber: state.roundNumber });
  showGameOver(data);
});

// ── QUESTION UI ───────────────────────────────────────────────────────────────
function showQuestionUI(question, timeLimit, remaining) {
  document.getElementById('state-idle').classList.add('hidden');
  document.getElementById('state-result').classList.add('hidden');
  document.getElementById('state-question').classList.remove('hidden');

  document.getElementById('q-round-label').textContent = `第 ${state.roundNumber} 题`;
  document.getElementById('q-text').textContent = question.text;

  const optContainer = document.getElementById('q-options');
  const labels = ['A', 'B', 'C', 'D'];
  optContainer.innerHTML = question.options.map((opt, i) => `
    <label class="option-item" id="opt-item-${i}">
      <input type="checkbox" id="opt-cb-${i}" value="${i}">
      <span class="option-label">${labels[i]}</span>
      <span class="option-text">${opt}</span>
    </label>
  `).join('');

  // Attach change listeners
  question.options.forEach((_, i) => {
    const cb = document.getElementById(`opt-cb-${i}`);
    cb.addEventListener('change', () => {
      const item = document.getElementById(`opt-item-${i}`);
      if (cb.checked) {
        state.selectedOptions.add(i);
        item.classList.add('selected');
      } else {
        state.selectedOptions.delete(i);
        item.classList.remove('selected');
      }
    });
  });

  if (state.answered) {
    showAnsweredState();
  } else {
    document.getElementById('btn-submit').classList.remove('hidden');
    document.getElementById('answered-badge').classList.add('hidden');
    document.getElementById('btn-submit').disabled = false;
  }

  startCountdown(timeLimit, remaining);
}

document.getElementById('btn-submit').addEventListener('click', submitAnswer);

function submitAnswer() {
  if (state.answered) return;
  const answers = [...state.selectedOptions].sort();
  if (answers.length === 0) { toast('请至少选择一个答案', 'error'); return; }
  state.answered = true;
  showAnsweredState();
  socket.emit('player:answer', { answers });
}

function showAnsweredState() {
  document.getElementById('btn-submit').classList.add('hidden');
  document.getElementById('answered-badge').classList.remove('hidden');
  // Disable all checkboxes
  if (state.currentQuestion) {
    state.currentQuestion.options.forEach((_, i) => {
      const cb = document.getElementById(`opt-cb-${i}`);
      if (cb) cb.disabled = true;
    });
  }
}

function showIdle() {
  document.getElementById('state-idle').classList.remove('hidden');
  document.getElementById('state-question').classList.add('hidden');
  document.getElementById('state-result').classList.add('hidden');
}

// ── COUNTDOWN ─────────────────────────────────────────────────────────────────
function startCountdown(total, remaining) {
  stopCountdown();
  const circumference = 2 * Math.PI * 16; // r=16 => 100.53
  const circle = document.getElementById('countdown-circle');
  const numEl = document.getElementById('countdown-num');
  let left = remaining;

  function tick() {
    numEl.textContent = left;
    numEl.className = 'countdown-num' + (left <= 5 ? ' urgent' : '');
    const offset = circumference * (1 - left / total);
    if (circle) circle.style.strokeDashoffset = offset;
    if (left <= 0) {
      stopCountdown();
      return;
    }
    left--;
  }
  tick();
  state.countdownInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  if (state.countdownInterval) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
}

// ── RESULT REVEAL ─────────────────────────────────────────────────────────────
function showResultUI(data) {
  document.getElementById('state-question').classList.add('hidden');
  document.getElementById('state-idle').classList.add('hidden');
  document.getElementById('state-result').classList.remove('hidden');

  const myResult = data.results[state.myUid];
  const labels = ['A', 'B', 'C', 'D'];
  const correctLabels = data.correctIndices.map(i => labels[i]).join(', ');
  const correctTexts = data.correctAnswers.join(' / ');

  let html = `<p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.4rem;">第 ${data.roundNumber} 题结果</p>`;
  html += `<p style="margin-bottom:0.4rem;font-weight:600;">${data.questionText}</p>`;
  html += `<p style="font-size:0.85rem;margin-bottom:0.75rem;color:var(--success);">✅ 正确答案: ${correctLabels} — ${correctTexts}</p>`;

  if (myResult) {
    if (!myResult.answered) {
      html += `<div class="result-reveal wrong-result"><span style="font-size:1.1rem;">⏱️</span> 超时未答，本轮不移动</div>`;
    } else if (myResult.correct) {
      html += `<div class="result-reveal correct-result"><span style="font-size:1.1rem;">🎉</span> 回答正确！掷出 <b>${myResult.dice}</b> 点，前进到第 <b>${myResult.newPos}</b> 格</div>`;
    } else {
      html += `<div class="result-reveal wrong-result"><span style="font-size:1.1rem;">❌</span> 回答错误，停留在第 <b>${myResult.oldPos}</b> 格</div>`;
    }
  }

  const resultEl = document.getElementById('result-reveal');
  resultEl.innerHTML = html;
  resultEl.className = 'result-reveal' + (myResult?.correct ? ' correct-result' : myResult?.answered === false ? '' : ' wrong-result');

  document.getElementById('game-status-bar').textContent = `第 ${data.roundNumber} 题结束 | 等待下一题…`;

  if (data.unusedLeft === 0) {
    toast('题库已用完，管理员可结束游戏', 'info');
  }
}

// ── RESOLUTION ANIMATION ──────────────────────────────────────────────────────
function runResolutionAnimation(data) {
  const myResult = data.results[state.myUid];
  if (!myResult || !myResult.correct || myResult.dice === null) {
    // Wrong/timeout: just re-render board
    renderBoard();
    Board.renderMiniScoreboard('mini-scoreboard', data.state.players, state.boardSize, state.myUid);
    return;
  }

  // Show dice animation first
  showDiceAnimation(myResult.dice, () => {
    // Animate movement step by step
    const localPlayers = JSON.parse(JSON.stringify(data.state.players));
    // Start from old position for animation
    if (localPlayers[state.myUid]) localPlayers[state.myUid].position = myResult.oldPos;
    renderBoardWithPlayers(localPlayers);

    Board.animateMovement(
      state.myUid,
      myResult.oldPos,
      myResult.newPos,
      state.boardSize,
      state.luckySquares,
      localPlayers,
      state.myUid,
      'player-board',
      null, // onStep
      () => {
        // Final render with authoritative state
        applyState(data.state);
        renderBoard();
        Board.renderMiniScoreboard('mini-scoreboard', state.players, state.boardSize, state.myUid);

        // Lucky square animation
        if (myResult.hitLucky) {
          Board.triggerLuckyAnimation(myResult.newPos);
          toast('⭐ 踩到幸运格子!', 'success');
        }

        // Finished
        if (myResult.justFinished) {
          toast(`🏁 到达终点！第 ${data.state.players[state.myUid]?.finishOrder} 名！`, 'success');
        }
      }
    );
  });
}

function renderBoardWithPlayers(players) {
  // Temporarily render with given players (for animation frames)
  Board.render('player-board', state.boardSize, state.luckySquares, players, state.myUid);
}

// ── DICE ANIMATION ────────────────────────────────────────────────────────────
function showDiceAnimation(result, onDone) {
  const overlay = document.getElementById('dice-overlay');
  const box = document.getElementById('dice-box');
  const label = document.getElementById('dice-label');
  overlay.classList.remove('hidden');
  box.classList.remove('settled');
  box.textContent = '🎲';
  label.textContent = '掷骰子…';

  let spins = 0;
  const maxSpins = 14;
  const spinInterval = setInterval(() => {
    box.textContent = DICE_FACES[Math.floor(Math.random() * 6)];
    spins++;
    if (spins >= maxSpins) {
      clearInterval(spinInterval);
      box.textContent = DICE_FACES[result - 1];
      box.classList.add('settled');
      label.textContent = `掷出 ${result} 点！`;
      setTimeout(() => {
        overlay.classList.add('hidden');
        box.classList.remove('settled');
        if (onDone) onDone();
      }, 800);
    }
  }, 80);
}

// ── GAME OVER ─────────────────────────────────────────────────────────────────
function showGameOver(data) {
  showView('gameover');
  const lbEl = document.getElementById('gameover-leaderboard');
  const rankEmojis = ['🥇', '🥈', '🥉'];

  lbEl.innerHTML = data.leaderboard.map((entry, i) => {
    const isMe = entry.id === state.myUid;
    const rankClass = i < 3 ? `top${i + 1}` : '';
    const rankDisplay = rankEmojis[i] || `#${entry.rank}`;
    return `<div class="lb-row ${rankClass}${isMe ? ' me' : ''}" style="${isMe ? 'border-color:var(--primary);background:rgba(255,215,0,0.12);' : ''}">
      <div class="lb-rank">${rankDisplay}</div>
      <div class="token" style="background:${Board.playerColor(entry.id)};">${Board.initials(entry.id)}</div>
      <div class="lb-name">${entry.id}${isMe ? ' (你)' : ''}</div>
      <div class="lb-detail">${entry.finished ? '🏁 完赛' : `位置 ${entry.position}`}${entry.luckyCount > 0 ? ` ⭐×${entry.luckyCount}` : ''}</div>
    </div>`;
  }).join('');

  if (data.luckyPlayers && data.luckyPlayers.length > 0) {
    document.getElementById('gameover-lucky').classList.remove('hidden');
    document.getElementById('lucky-list').innerHTML = data.luckyPlayers.map(p =>
      `<div class="lb-row">
        <div class="token" style="background:${Board.playerColor(p.id)};">${Board.initials(p.id)}</div>
        <div class="lb-name">${p.id}</div>
        <div class="lb-detail">⭐ 幸运格 ×${p.luckyCount}</div>
      </div>`
    ).join('');
  }
}

document.getElementById('btn-play-again').addEventListener('click', () => {
  location.reload();
});
