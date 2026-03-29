const socket = io();

const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63','#00bcd4','#ff5722'];

const state = {
  roomId: null,
  playerId: null,
  gameState: null,
  players: {},
  surpriseSquares: [],
  boardSize: 30,
  myAnswered: false,
  timerInterval: null,
  timerMax: 30,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function playerColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return COLORS[h % COLORS.length];
}

function initials(id) {
  return id.slice(0, 2).toUpperCase();
}

function rankMedal(rank) {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
}

function diceFace(n) {
  return ['','⚀','⚁','⚂','⚃','⚄','⚅'][n] || n;
}

// ── Join ─────────────────────────────────────────────────────────────────────

function doJoin() {
  const roomId = document.getElementById('inp-room').value.trim().toUpperCase();
  const playerId = document.getElementById('inp-player').value.trim();
  const password = document.getElementById('inp-password').value.trim();

  const errEl = document.getElementById('join-error');
  errEl.style.display = 'none';

  if (!roomId || roomId.length < 4) return showErr('请输入房间号');
  if (!playerId || playerId.length < 2) return showErr('ID至少2个字符');
  if (!password || !/^\d{6}$/.test(password)) return showErr('密码必须是6位数字');

  function showErr(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  state.roomId = roomId;
  state.playerId = playerId;
  socket.emit('player:join', { roomId, playerId, password });
}

document.getElementById('inp-room').addEventListener('input', function() {
  this.value = this.value.toUpperCase();
});

// Enter key support
['inp-room','inp-player','inp-password'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') doJoin();
  });
});

// ── Socket events ────────────────────────────────────────────────────────────

socket.on('join:error', (msg) => {
  const errEl = document.getElementById('join-error');
  errEl.textContent = msg;
  errEl.style.display = 'block';
});

socket.on('player:joined', ({ playerId, state: s }) => {
  applyState(s);
  document.getElementById('wait-room-info').textContent =
    `房间 ${s.id} · 你的ID：${playerId}`;
  showView('view-waiting');
  renderWaitingPlayers(s.players);
});

socket.on('admin:state-update', (s) => {
  applyState(s);
  if (s.gameState === 'waiting') renderWaitingPlayers(s.players);
  else if (s.gameState === 'playing') renderMiniScoreboard();
});

socket.on('game:started', (s) => {
  applyState(s);
  document.getElementById('game-room-title').textContent = `房间 ${s.id}`;
  showView('view-game');
  renderBoard();
  renderMiniScoreboard();
});

socket.on('game:question', ({ question, timeLimit, remaining, roundNumber, alreadyAnswered }) => {
  state.myAnswered = alreadyAnswered;
  state.timerMax = timeLimit;

  document.getElementById('game-round-info').textContent = `第 ${roundNumber} 题`;
  document.getElementById('q-round-badge').textContent = `第 ${roundNumber} 题`;

  // Hide result overlay
  document.getElementById('result-overlay').style.display = 'none';

  const qArea = document.getElementById('question-area');
  const myPlayer = state.players[state.playerId];

  if (myPlayer && myPlayer.finished) {
    qArea.style.display = 'none';
    return;
  }

  qArea.style.display = 'block';
  document.getElementById('q-text').textContent = question.text;

  const labels = ['A','B','C','D'];
  const optDiv = document.getElementById('q-options');
  optDiv.innerHTML = '';
  question.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.innerHTML = `<span class="option-label">${labels[i]}</span><span>${opt}</span>`;
    btn.disabled = alreadyAnswered;
    if (!alreadyAnswered) {
      btn.onclick = () => submitAnswer(i, question.options);
    }
    optDiv.appendChild(btn);
  });

  document.getElementById('answered-notice').style.display = alreadyAnswered ? 'block' : 'none';

  startTimer(remaining, timeLimit);
});

socket.on('game:round-result', ({ roundNumber, correctIndex, correctAnswer, results, state: s }) => {
  stopTimer();
  applyState(s);
  renderBoard();
  renderMiniScoreboard();

  // Mark correct/wrong options visually
  const optBtns = document.querySelectorAll('.option-btn');
  optBtns.forEach((btn, i) => {
    btn.disabled = true;
    if (i === correctIndex) btn.classList.add('correct');
    else if (btn.classList.contains('selected')) btn.classList.add('wrong');
  });

  // Show result overlay
  showRoundResult(results, correctIndex, correctAnswer);

  // Check surprise
  const myResult = results[state.playerId];
  if (myResult && myResult.hitSurprise) {
    showSurpriseToast();
  }

  // Update my position badge
  updateMyPosBadge();
});

socket.on('game:ended', ({ leaderboard }) => {
  stopTimer();
  document.getElementById('result-overlay').style.display = 'none';
  renderFinalLeaderboard(leaderboard);
  showView('view-gameover');
});

socket.on('error', (msg) => {
  alert('错误：' + msg);
});

// ── State ─────────────────────────────────────────────────────────────────────

function applyState(s) {
  state.gameState = s.gameState;
  state.players = s.players;
  state.surpriseSquares = s.surpriseSquares || [];
  state.boardSize = s.settings.boardSize;

  const me = state.players[state.playerId];
  if (me) {
    updateMyPosBadge();
    if (me.finished) {
      document.getElementById('finished-banner').style.display = 'block';
      document.getElementById('my-rank-num').textContent =
        rankMedal(s.finishedPlayers.indexOf(state.playerId) + 1);
      document.getElementById('question-area').style.display = 'none';
      stopTimer();
    }
  }
}

function updateMyPosBadge() {
  const me = state.players[state.playerId];
  if (!me) return;
  document.getElementById('my-pos-badge').textContent =
    me.finished ? '🏁 已到终点' : `📍 位置 ${me.position} / ${state.boardSize}`;
}

// ── Answer ────────────────────────────────────────────────────────────────────

function submitAnswer(index, options) {
  if (state.myAnswered) return;
  state.myAnswered = true;

  const btns = document.querySelectorAll('.option-btn');
  btns.forEach((b, i) => {
    b.disabled = true;
    if (i === index) b.classList.add('selected');
  });

  document.getElementById('answered-notice').style.display = 'block';
  socket.emit('player:answer', { answerIndex: index });
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function startTimer(remaining, max) {
  stopTimer();
  const circle = document.getElementById('timer-circle');
  const numEl = document.getElementById('timer-num');
  const circumference = 125.66;

  let t = remaining;
  function tick() {
    numEl.textContent = Math.max(0, t);
    const pct = t / max;
    circle.style.strokeDashoffset = circumference * (1 - pct);
    circle.style.stroke = pct > 0.4 ? 'var(--primary)' : pct > 0.2 ? 'var(--danger)' : 'var(--danger)';
    if (t <= 0) { stopTimer(); return; }
    t--;
    state.timerInterval = setTimeout(tick, 1000);
  }
  tick();
}

function stopTimer() {
  clearTimeout(state.timerInterval);
  state.timerInterval = null;
}

// ── Board ─────────────────────────────────────────────────────────────────────

function renderBoard() {
  const { boardSize, surpriseSquares, players } = state;
  const myId = state.playerId;
  const cols = 10;
  const rows = Math.ceil(boardSize / cols);

  // Players at position 0 (start)
  const atStart = Object.values(players).filter(p => p.position === 0 && !p.finished);
  const startArea = document.getElementById('start-area');
  if (atStart.length > 0) {
    startArea.innerHTML = '<span class="start-area-label">🏠 起点</span>' +
      atStart.map(p => `
        <span class="player-token${p.id === myId ? ' me' : ''}"
              style="background:${playerColor(p.id)}"
              title="${p.id}">${initials(p.id)}</span>
      `).join('');
    startArea.style.display = 'flex';
  } else {
    startArea.style.display = 'none';
  }

  const container = document.getElementById('board-container');
  let html = '';

  // Render rows from top (high numbers) to bottom (low numbers)
  for (let rowIdx = rows - 1; rowIdx >= 0; rowIdx--) {
    const startNum = rowIdx * cols + 1;
    const endNum = Math.min(startNum + cols - 1, boardSize);
    const leftToRight = rowIdx % 2 === 0;

    const nums = [];
    for (let n = startNum; n <= endNum; n++) nums.push(n);
    if (!leftToRight) nums.reverse();

    html += '<div class="board-row">';
    for (const n of nums) {
      html += makeCell(n, n === boardSize, surpriseSquares.includes(n), players, myId);
    }
    html += '</div>';
  }

  container.innerHTML = html;
}

function makeCell(num, isFinish, isSurprise, players, myId) {
  const here = Object.values(players).filter(p => p.position === num);
  const meHere = here.some(p => p.id === myId);

  let cls = 'board-cell';
  if (isFinish) cls += ' cell-finish';
  else if (isSurprise) cls += ' cell-surprise';

  let top = '';
  if (isFinish) top = `<span class="cell-num">${num}</span><span class="cell-icon">🏁</span>`;
  else if (isSurprise) top = `<span class="cell-num">${num}</span><span class="cell-icon">⭐</span>`;
  else top = `<span class="cell-num">${num}</span>`;

  const myMarker = meHere ? '<div class="cell-my-marker"></div>' : '';

  let tokens = '';
  if (here.length > 0) {
    tokens = '<div class="cell-players">';
    const show = here.slice(0, 3);
    for (const p of show) {
      tokens += `<span class="player-token${p.id === myId ? ' me' : ''}"
        style="background:${playerColor(p.id)}" title="${p.id}">${initials(p.id)}</span>`;
    }
    if (here.length > 3) {
      tokens += `<span class="player-token" style="background:#555">+${here.length - 3}</span>`;
    }
    tokens += '</div>';
  }

  return `<div class="${cls}">${myMarker}${top}${tokens}</div>`;
}

// ── Mini scoreboard ───────────────────────────────────────────────────────────

function renderMiniScoreboard() {
  const sorted = Object.values(state.players).sort((a, b) => {
    if (a.finished && !b.finished) return -1;
    if (!a.finished && b.finished) return 1;
    if (a.finished && b.finished) return (a.finishOrder || 0) - (b.finishOrder || 0);
    return b.position - a.position;
  });

  const el = document.getElementById('mini-scoreboard');
  el.innerHTML = sorted.map(p => {
    const isMe = p.id === state.playerId;
    const cls = `mini-row${isMe ? ' me' : ''}${p.finished ? ' finished' : ''}`;
    const posText = p.finished ? '🏁' : `${p.position}`;
    return `<div class="${cls}">
      <span class="mini-token" style="background:${playerColor(p.id)}">${initials(p.id)}</span>
      <span class="mini-name" title="${p.id}">${p.id}${isMe ? ' (我)' : ''}</span>
      <span class="mini-pos">${posText}</span>
    </div>`;
  }).join('');
}

// ── Waiting room ──────────────────────────────────────────────────────────────

function renderWaitingPlayers(players) {
  const el = document.getElementById('wait-player-list');
  const list = Object.values(players);
  if (list.length === 0) {
    el.innerHTML = '<span class="text-muted text-sm">暂无玩家</span>';
    return;
  }
  el.innerHTML = list.map(p => `
    <div class="player-chip">
      <span class="dot${p.connected ? '' : ' offline'}"></span>
      <span class="player-token" style="background:${playerColor(p.id)};width:22px;height:22px">${initials(p.id)}</span>
      <span>${p.id}</span>
    </div>
  `).join('');
}

// ── Round result ──────────────────────────────────────────────────────────────

function showRoundResult(results, correctIndex, correctAnswer) {
  const myResult = results[state.playerId];

  let myHtml = '';
  if (myResult) {
    if (!myResult.answered) {
      myHtml = `<div class="result-my timeout">
        <div class="result-icon">⏰</div>
        <div style="font-weight:700">超时未答</div>
        <div class="result-pos">位置不变：${myResult.newPos}</div>
      </div>`;
    } else if (myResult.correct) {
      myHtml = `<div class="result-my correct">
        <div class="result-icon">✅</div>
        <div style="font-weight:700;color:var(--success)">回答正确！</div>
        <div class="result-dice">${diceFace(myResult.dice)} 摇出 ${myResult.dice} 点</div>
        <div class="result-move text-success">前进 ${myResult.dice} 步</div>
        <div class="result-pos">${myResult.oldPos} → ${myResult.newPos}</div>
        ${myResult.hitSurprise ? '<div style="color:var(--primary);font-weight:700;margin-top:6px">⭐ 踩到惊喜格！</div>' : ''}
        ${myResult.justFinished ? '<div style="color:var(--primary);font-weight:700;margin-top:6px">🏁 到达终点！</div>' : ''}
      </div>`;
    } else {
      myHtml = `<div class="result-my wrong">
        <div class="result-icon">❌</div>
        <div style="font-weight:700;color:var(--danger)">回答错误</div>
        <div class="text-sm text-muted">正确答案：${correctAnswer}</div>
        <div class="result-dice">${diceFace(myResult.dice)} 摇出 ${myResult.dice} 点</div>
        <div class="result-move text-danger">后退 ${myResult.dice} 步</div>
        <div class="result-pos">${myResult.oldPos} → ${myResult.newPos}</div>
      </div>`;
    }
  }

  document.getElementById('result-my-section').innerHTML = myHtml;

  const othersHtml = Object.entries(results)
    .filter(([id]) => id !== state.playerId)
    .map(([id, r]) => {
      let icon, detail;
      if (!r.answered) {
        icon = '⏰'; detail = '超时';
      } else if (r.correct) {
        icon = '✅'; detail = `+${r.dice} → ${r.newPos}${r.hitSurprise ? ' ⭐' : ''}${r.justFinished ? ' 🏁' : ''}`;
      } else {
        icon = '❌'; detail = `-${r.dice} → ${r.newPos}`;
      }
      return `<div class="result-other-row">
        <span class="player-token" style="background:${playerColor(id)};width:22px;height:22px">${initials(id)}</span>
        <span class="result-player-name">${id}</span>
        <span>${icon}</span>
        <span class="text-muted text-sm">${detail}</span>
      </div>`;
    }).join('');

  document.getElementById('result-others').innerHTML = othersHtml || '<div class="text-muted text-sm">（无其他玩家数据）</div>';
  document.getElementById('result-overlay').style.display = 'flex';
}

// ── Surprise toast ────────────────────────────────────────────────────────────

function showSurpriseToast() {
  const el = document.getElementById('surprise-toast');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Final leaderboard ─────────────────────────────────────────────────────────

function renderFinalLeaderboard(leaderboard) {
  const el = document.getElementById('final-leaderboard');
  el.innerHTML = leaderboard.map(p => {
    const rankClass = p.rank === 1 ? 'gold' : p.rank === 2 ? 'silver' : p.rank === 3 ? 'bronze' : '';
    const isMe = p.id === state.playerId;
    return `<div class="lb-row${isMe ? '" style="border:1px solid var(--primary)' : ''}">
      <div class="lb-rank ${rankClass}">${rankMedal(p.rank)}</div>
      <span class="player-token" style="background:${playerColor(p.id)};width:26px;height:26px;font-size:0.65rem">${initials(p.id)}</span>
      <div class="lb-name">${p.id}${isMe ? ' （我）' : ''}</div>
      <div class="lb-pos">${p.finished ? '🏁 终点' : `位置 ${p.position}`}</div>
      ${p.surpriseCount > 0 ? `<span class="lb-badge surprise">⭐×${p.surpriseCount}</span>` : ''}
    </div>`;
  }).join('');
}
