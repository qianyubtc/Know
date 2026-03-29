const socket = io();

const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63','#00bcd4','#ff5722'];

const admin = {
  roomId: null,
  password: null,
  settings: {},
  questions: [],
  surpriseSquares: [],
  gameState: null,
  players: {},
  boardSize: 30,
  roundNumber: 0,
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

function initials(id) { return id.slice(0, 2).toUpperCase(); }

function rankMedal(rank) {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
}

function showAlert(elId, msg, type = 'error') {
  const el = document.getElementById(elId);
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.style.display = 'block';
  if (type !== 'error') setTimeout(() => el.style.display = 'none', 3000);
}

function hideAlert(elId) {
  document.getElementById(elId).style.display = 'none';
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchHomeTab(name, btn) {
  document.querySelectorAll('#view-home .tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('home-tab-create').classList.toggle('active', name === 'create');
  document.getElementById('home-tab-login').classList.toggle('active', name === 'login');
}

function switchSetupTab(name, btn) {
  document.querySelectorAll('#view-setup .tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ['questions','surprise','settings'].forEach(t => {
    document.getElementById(`setup-tab-${t}`).classList.toggle('active', t === name);
  });
}

// ── Create room ───────────────────────────────────────────────────────────────

async function doCreate() {
  const password = document.getElementById('c-password').value.trim();
  const boardSize = document.getElementById('c-board').value;
  const timeLimit = document.getElementById('c-time').value;
  const minPlayersToEnd = document.getElementById('c-min').value;

  hideAlert('create-error');
  if (!password) return showAlert('create-error', '请设置管理员密码');

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: password, boardSize, timeLimit, minPlayersToEnd }),
    });
    const data = await res.json();
    if (!res.ok) return showAlert('create-error', data.error || '创建失败');

    admin.roomId = data.roomId;
    admin.password = password;
    admin.settings = { boardSize: parseInt(boardSize), timeLimit: parseInt(timeLimit), minPlayersToEnd: parseInt(minPlayersToEnd) };
    admin.questions = [];
    admin.surpriseSquares = [];

    enterSetup();
  } catch (e) {
    showAlert('create-error', '网络错误，请重试');
  }
}

// ── Login to existing room ────────────────────────────────────────────────────

async function doLogin() {
  const roomId = document.getElementById('l-room').value.trim().toUpperCase();
  const password = document.getElementById('l-password').value.trim();

  hideAlert('login-error');
  if (!roomId) return showAlert('login-error', '请输入房间号');
  if (!password) return showAlert('login-error', '请输入密码');

  try {
    const res = await fetch(`/api/rooms/${roomId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) return showAlert('login-error', data.error || '验证失败');

    admin.roomId = roomId;
    admin.password = password;
    admin.settings = data.settings;
    admin.questions = data.questions;
    admin.surpriseSquares = data.surpriseSquares;
    admin.gameState = data.gameState;

    if (data.gameState === 'playing' || data.gameState === 'ended') {
      enterMonitor();
      socket.emit('admin:join', { roomId, password });
    } else {
      enterSetup();
    }
  } catch (e) {
    showAlert('login-error', '网络错误，请重试');
  }
}

// ── Enter setup view ──────────────────────────────────────────────────────────

function enterSetup() {
  document.getElementById('setup-room-badge').textContent = admin.roomId;
  document.getElementById('setup-room-info').textContent =
    `棋盘 ${admin.settings.boardSize} 格 · 每题 ${admin.settings.timeLimit}s`;

  // Pre-fill settings tab
  document.getElementById('s-board').value = admin.settings.boardSize;
  document.getElementById('s-time').value = admin.settings.timeLimit;
  document.getElementById('s-min').value = admin.settings.minPlayersToEnd;

  renderQuestionList();
  renderSurpriseList();
  showView('view-setup');

  // Join socket room for live player updates
  socket.emit('admin:join', { roomId: admin.roomId, password: admin.password });
}

// ── Enter monitor view ────────────────────────────────────────────────────────

function enterMonitor() {
  document.getElementById('monitor-room-badge').textContent = admin.roomId;
  showView('view-monitor');
}

// ── Add question ──────────────────────────────────────────────────────────────

async function doAddQuestion() {
  const text = document.getElementById('q-text-input').value.trim();
  const opts = [...document.querySelectorAll('.q-opt')].map(i => i.value.trim()).filter(Boolean);
  const correctIndex = document.getElementById('q-correct').value;

  hideAlert('add-q-error');
  if (!text) return showAlert('add-q-error', '请输入题目内容');
  if (opts.length < 2) return showAlert('add-q-error', '至少需要2个选项');

  try {
    const res = await fetch(`/api/rooms/${admin.roomId}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: admin.password, text, options: opts, correctIndex }),
    });
    const data = await res.json();
    if (!res.ok) return showAlert('add-q-error', data.error || '添加失败');

    admin.questions = data.questions;

    // Clear form
    document.getElementById('q-text-input').value = '';
    document.querySelectorAll('.q-opt').forEach(i => i.value = '');
    document.getElementById('q-correct').value = '0';

    showAlert('add-q-success', `添加成功！当前题库共 ${admin.questions.length} 题`, 'success');
    renderQuestionList();
  } catch (e) {
    showAlert('add-q-error', '网络错误');
  }
}

async function doDeleteQuestion(qid) {
  try {
    const res = await fetch(`/api/rooms/${admin.roomId}/questions/${qid}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: admin.password }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || '删除失败');
    admin.questions = data.questions;
    renderQuestionList();
  } catch (e) {
    alert('网络错误');
  }
}

function renderQuestionList() {
  const labels = ['A','B','C','D'];
  const el = document.getElementById('question-list');
  document.getElementById('q-count').textContent = `(${admin.questions.length} 题)`;

  if (admin.questions.length === 0) {
    el.innerHTML = '<div class="text-muted text-sm">暂无题目，请先添加</div>';
    return;
  }

  el.innerHTML = admin.questions.map((q, i) => {
    const opts = q.options.map((o, j) =>
      `<span class="${j === q.correctIndex ? 'correct' : ''}">${labels[j]}.${o}</span>`
    ).join('  ');
    return `<div class="q-item">
      <div class="q-item-body">
        <div class="q-item-text">${i + 1}. ${q.text}</div>
        <div class="q-item-opts">${opts}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="doDeleteQuestion('${q.id}')">删除</button>
    </div>`;
  }).join('');
}

// ── Surprise squares ──────────────────────────────────────────────────────────

async function doAddSurprise() {
  const val = parseInt(document.getElementById('surprise-inp').value);
  hideAlert('surprise-error');

  if (isNaN(val) || val < 1 || val >= admin.settings.boardSize) {
    return showAlert('surprise-error', `格子编号须在 1 到 ${admin.settings.boardSize - 1} 之间`);
  }
  if (admin.surpriseSquares.includes(val)) {
    return showAlert('surprise-error', '该格子已是惊喜格');
  }

  const newSquares = [...admin.surpriseSquares, val].sort((a, b) => a - b);
  await saveSurprises(newSquares);
  document.getElementById('surprise-inp').value = '';
}

async function doRemoveSurprise(n) {
  const newSquares = admin.surpriseSquares.filter(s => s !== n);
  await saveSurprises(newSquares);
}

async function saveSurprises(squares) {
  try {
    const res = await fetch(`/api/rooms/${admin.roomId}/surprise-squares`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: admin.password, squares }),
    });
    const data = await res.json();
    if (!res.ok) return showAlert('surprise-error', data.error || '保存失败');
    admin.surpriseSquares = data.surpriseSquares;
    renderSurpriseList();
  } catch (e) {
    showAlert('surprise-error', '网络错误');
  }
}

function renderSurpriseList() {
  const el = document.getElementById('surprise-list');
  if (admin.surpriseSquares.length === 0) {
    el.innerHTML = '<span class="text-muted text-sm">暂无惊喜格</span>';
    return;
  }
  el.innerHTML = admin.surpriseSquares.map(n =>
    `<div class="surprise-sq" onclick="doRemoveSurprise(${n})">⭐ 第${n}格 ×</div>`
  ).join('');
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function doSaveSettings() {
  const boardSize = document.getElementById('s-board').value;
  const timeLimit = document.getElementById('s-time').value;
  const minPlayersToEnd = document.getElementById('s-min').value;

  try {
    const res = await fetch(`/api/rooms/${admin.roomId}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: admin.password, boardSize, timeLimit, minPlayersToEnd }),
    });
    const data = await res.json();
    if (!res.ok) return showAlert('settings-msg', data.error || '保存失败');
    admin.settings = data.settings;
    document.getElementById('setup-room-info').textContent =
      `棋盘 ${admin.settings.boardSize} 格 · 每题 ${admin.settings.timeLimit}s`;
    showAlert('settings-msg', '设置已保存', 'success');
  } catch (e) {
    showAlert('settings-msg', '网络错误');
  }
}

// ── Start game ────────────────────────────────────────────────────────────────

function doStartGame() {
  if (admin.questions.length === 0) return alert('请先添加题目');
  const playerCount = Object.keys(admin.players).length;
  if (playerCount === 0) return alert('还没有玩家加入');
  if (!confirm(`确认开始游戏？当前有 ${playerCount} 名玩家，题库共 ${admin.questions.length} 题`)) return;
  socket.emit('admin:start-game');
}

// ── End game ──────────────────────────────────────────────────────────────────

function doEndGame() {
  if (!confirm('确认结束游戏？将显示当前排行榜并结束所有玩家的游戏。')) return;
  socket.emit('admin:end-game');
}

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('admin:joined', (state) => {
  applyState(state);
  if (state.gameState === 'playing') {
    enterMonitor();
    renderMonitor();
  }
});

socket.on('admin:state-update', (state) => {
  applyState(state);
  if (state.gameState === 'waiting') {
    renderSetupPlayerCount(state);
  } else if (state.gameState === 'playing') {
    renderMonitor();
  }
});

socket.on('game:started', (state) => {
  applyState(state);
  enterMonitor();
  renderMonitor();
});

socket.on('game:question', ({ roundNumber }) => {
  admin.roundNumber = roundNumber;
  document.getElementById('monitor-round').textContent = `第 ${roundNumber} 题`;
});

socket.on('game:round-result', ({ state }) => {
  applyState(state);
  renderMonitor();
});

socket.on('admin:can-end', ({ finishedCount }) => {
  const el = document.getElementById('can-end-alert');
  el.textContent = `🎉 已有 ${finishedCount} 名玩家到达终点，达到结束条件，可点击"结束游戏"`;
  el.style.display = 'block';
});

socket.on('game:ended', ({ leaderboard }) => {
  renderAdminLeaderboard(leaderboard);
  showView('view-ended');
});

socket.on('error', (msg) => {
  alert('错误：' + msg);
});

// ── State ─────────────────────────────────────────────────────────────────────

function applyState(state) {
  admin.gameState = state.gameState;
  admin.players = state.players;
  admin.boardSize = state.settings.boardSize;
  admin.roundNumber = state.roundNumber;
}

function renderSetupPlayerCount(state) {
  const count = Object.keys(state.players).length;
  const btn = document.getElementById('btn-start');
  btn.textContent = `开始游戏（${count} 人）`;
}

// ── Monitor rendering ─────────────────────────────────────────────────────────

function renderMonitor() {
  const info = `房间 ${admin.roomId} · 第 ${admin.roundNumber} 题`;
  document.getElementById('monitor-info').textContent = info;

  const sorted = Object.values(admin.players).sort((a, b) => {
    if (a.finished && !b.finished) return -1;
    if (!a.finished && b.finished) return 1;
    if (a.finished && b.finished) return (a.finishOrder || 0) - (b.finishOrder || 0);
    return b.position - a.position;
  });

  // Progress list
  const listEl = document.getElementById('player-monitor-list');
  listEl.innerHTML = sorted.map(p => {
    const pct = Math.round((p.position / admin.boardSize) * 100);
    const status = p.finished ? '🏁 终点' : `${p.position} / ${admin.boardSize}`;
    const offline = p.connected ? '' : ' (离线)';
    return `<div class="player-monitor-row">
      <span class="mini-token" style="background:${playerColor(p.id)}">${initials(p.id)}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.id}">
        ${p.id}${offline}
      </span>
      <div class="prog-bar" style="width:120px">
        <div class="prog-fill" style="width:${pct}%"></div>
      </div>
      <span class="text-sm text-muted" style="width:70px;text-align:right">${status}</span>
      ${p.surpriseCount > 0 ? `<span class="text-sm" style="color:var(--success)">⭐×${p.surpriseCount}</span>` : ''}
    </div>`;
  }).join('');

  // Mini leaderboard
  const lbEl = document.getElementById('monitor-leaderboard');
  lbEl.innerHTML = sorted.map((p, i) => {
    const rank = i + 1;
    const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
    return `<div class="lb-row">
      <div class="lb-rank ${rankClass}">${rankMedal(rank)}</div>
      <span class="player-token" style="background:${playerColor(p.id)};width:24px;height:24px;font-size:0.6rem">${initials(p.id)}</span>
      <div class="lb-name">${p.id}</div>
      <div class="lb-pos">${p.finished ? '🏁 终点' : `位置 ${p.position}`}</div>
      ${p.surpriseCount > 0 ? `<span class="lb-badge surprise">⭐×${p.surpriseCount}</span>` : ''}
    </div>`;
  }).join('');
}

function renderAdminLeaderboard(leaderboard) {
  document.getElementById('admin-final-lb').innerHTML = leaderboard.map(p => {
    const rankClass = p.rank === 1 ? 'gold' : p.rank === 2 ? 'silver' : p.rank === 3 ? 'bronze' : '';
    return `<div class="lb-row">
      <div class="lb-rank ${rankClass}">${rankMedal(p.rank)}</div>
      <span class="player-token" style="background:${playerColor(p.id)};width:26px;height:26px;font-size:0.65rem">${initials(p.id)}</span>
      <div class="lb-name">${p.id}</div>
      <div class="lb-pos">${p.finished ? '🏁 终点' : `位置 ${p.position}`}</div>
      ${p.surpriseCount > 0 ? `<span class="lb-badge surprise">⭐×${p.surpriseCount}</span>` : ''}
    </div>`;
  }).join('');
}
