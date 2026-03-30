// Admin client logic
const socket = io({ transports: ['websocket'], upgrade: false });

const admin = {
  roomId: null,
  password: null,
  gameState: 'waiting',
  players: {},
  questions: [],
  luckySquares: [],
  boardSize: 30,
  timeLimit: 30,
  roundNumber: 0,
  pendingLucky: [],
  countdownInterval: null,
  currentQuestionData: null,
};

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
  }, 3500);
}

// ── Views ─────────────────────────────────────────────────────────────────────
const views = ['view-home', 'view-setup', 'view-playing', 'view-admin-gameover'];
function showView(id) {
  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.classList.remove('active');
  });
  const target = document.getElementById(id);
  if (target) target.classList.add('active');
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function initTabs(tabsId) {
  const tabsEl = document.getElementById(tabsId);
  if (!tabsEl) return;
  tabsEl.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const panelId = btn.dataset.tab;
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Hide all panels in this tab group
      const allPanels = document.querySelectorAll(`#${panelId}`);
      // Find sibling panels by checking btn siblings
      tabsEl.querySelectorAll('.tab-btn').forEach(b => {
        const p = document.getElementById(b.dataset.tab);
        if (p) p.classList.remove('active');
      });
      const panel = document.getElementById(panelId);
      if (panel) panel.classList.add('active');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs('home-tabs');
  initTabs('setup-tabs');
});

// ── HOME: Create room ─────────────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', async () => {
  const password = document.getElementById('cr-password').value.trim();
  const boardSize = document.getElementById('cr-board-size').value;
  const timeLimit = document.getElementById('cr-time-limit').value;
  const luckyRaw = document.getElementById('cr-lucky').value.trim();
  const errEl = document.getElementById('home-error');
  errEl.classList.add('hidden');

  if (!password) { errEl.textContent = '请设置管理员密码'; errEl.classList.remove('hidden'); return; }

  const luckySquares = luckyRaw
    ? luckyRaw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0)
    : [];

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: password, boardSize, timeLimit, luckySquares }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }

    admin.roomId = data.roomId;
    admin.password = password;
    admin.boardSize = parseInt(boardSize);
    admin.timeLimit = parseInt(timeLimit);
    admin.luckySquares = luckySquares;
    admin.pendingLucky = [...luckySquares];

    connectAdminSocket();
  } catch (e) {
    errEl.textContent = '网络错误: ' + e.message;
    errEl.classList.remove('hidden');
  }
});

// ── HOME: Login ───────────────────────────────────────────────────────────────
document.getElementById('btn-login').addEventListener('click', async () => {
  const roomId = document.getElementById('lg-room').value.trim().toUpperCase();
  const password = document.getElementById('lg-password').value.trim();
  const errEl = document.getElementById('home-error');
  errEl.classList.add('hidden');

  if (!roomId || !password) { errEl.textContent = '请填写房间ID和密码'; errEl.classList.remove('hidden'); return; }

  try {
    const res = await fetch(`/api/rooms/${roomId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }

    admin.roomId = roomId;
    admin.password = password;
    admin.questions = data.questions || [];
    admin.luckySquares = data.luckySquares || [];
    admin.pendingLucky = [...admin.luckySquares];
    admin.boardSize = data.settings.boardSize;
    admin.timeLimit = data.settings.timeLimit;

    connectAdminSocket();
  } catch (e) {
    errEl.textContent = '网络错误: ' + e.message;
    errEl.classList.remove('hidden');
  }
});

function connectAdminSocket() {
  socket.emit('admin:join', { roomId: admin.roomId, password: admin.password });
}

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('error', (msg) => {
  toast('错误: ' + msg, 'error');
  document.getElementById('home-error').textContent = msg;
  document.getElementById('home-error').classList.remove('hidden');
});

socket.on('admin:joined', (state) => {
  applyState(state);
  if (state.gameState === 'waiting') {
    showView('view-setup');
    renderSetup();
  } else if (state.gameState === 'ended') {
    showView('view-playing');
    renderPlaying();
  } else {
    showView('view-playing');
    renderPlaying();
  }
  toast('已连接到房间 ' + admin.roomId, 'success');
});

socket.on('admin:state-update', (state) => {
  applyState(state);
  const v = currentView();
  if (v === 'view-setup') {
    updateSetupPlayerCount();
    renderSetupPlayerList();
  } else if (v === 'view-playing') {
    renderAdminBoard();
    renderAdminScoreboard();
    updatePlayingRoomInfo();
  }
});

socket.on('game:started', (state) => {
  applyState(state);
  showView('view-playing');
  renderPlaying();
  toast('🎮 游戏已开始', 'success');
  document.getElementById('btn-next-q').disabled = false;
});

socket.on('game:question', ({ question, timeLimit, roundNumber }) => {
  admin.roundNumber = roundNumber;
  admin.currentQuestionData = question;
  document.getElementById('playing-round').textContent = `第 ${roundNumber} 题`;
  document.getElementById('btn-next-q').disabled = true;
  showAdminQuestion(question, timeLimit);
  startAdminCountdown(timeLimit);
});

socket.on('game:resolved', (data) => {
  applyState(data.state);
  stopAdminCountdown();
  document.getElementById('btn-next-q').disabled = false;
  document.getElementById('admin-q-card').classList.remove('hidden');
  // Show correct answer
  const labels = ['A', 'B', 'C', 'D'];
  const correctLabels = data.correctIndices.map(i => labels[i]).join(', ');
  document.getElementById('admin-q-answer').textContent =
    `✅ 正确答案: ${correctLabels} — ${data.correctAnswers.join(' / ')}`;

  renderRoundResults(data);
  renderAdminBoard();
  renderAdminScoreboard();

  if (data.unusedLeft === 0) {
    document.getElementById('no-questions-alert').classList.remove('hidden');
    document.getElementById('btn-next-q').disabled = true;
    toast('⚠️ 题库已用完', 'error');
  }
});

socket.on('admin:no-questions', ({ message }) => {
  toast(message, 'error');
  document.getElementById('no-questions-alert').classList.remove('hidden');
  document.getElementById('btn-next-q').disabled = true;
});

socket.on('game:ended', (data) => {
  stopAdminCountdown();
  showView('view-admin-gameover');
  renderAdminGameOver(data);
});

// ── State application ─────────────────────────────────────────────────────────
function applyState(state) {
  admin.players = state.players || admin.players;
  admin.luckySquares = state.luckySquares || admin.luckySquares;
  admin.boardSize = state.settings?.boardSize || admin.boardSize;
  admin.timeLimit = state.settings?.timeLimit || admin.timeLimit;
  admin.gameState = state.gameState || admin.gameState;
  admin.roundNumber = state.roundNumber || admin.roundNumber;
}

function currentView() {
  for (const v of views) {
    const el = document.getElementById(v);
    if (el && el.classList.contains('active')) return v;
  }
  return null;
}

// ── SETUP VIEW ────────────────────────────────────────────────────────────────
function renderSetup() {
  document.getElementById('setup-room-info').textContent = `房间: ${admin.roomId}`;
  document.getElementById('set-board-size').value = admin.boardSize;
  document.getElementById('set-time-limit').value = admin.timeLimit;
  updateSetupPlayerCount();
  renderQuestionsList();
  renderLuckyTags();
  renderSetupPlayerList();
}

function updateSetupPlayerCount() {
  const count = Object.keys(admin.players).length;
  document.getElementById('setup-player-count').textContent = `${count} 玩家`;
}

function renderSetupPlayerList() {
  const list = document.getElementById('setup-player-list');
  const noPlayers = document.getElementById('sp-no-players');
  const players = Object.values(admin.players);
  if (players.length === 0) {
    noPlayers.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  noPlayers.classList.add('hidden');
  list.innerHTML = players.map(p => `
    <div class="score-row" style="margin-bottom:0.3rem;">
      <div class="token" style="background:${Board.playerColor(p.id)};">${Board.initials(p.id)}</div>
      <div class="score-name">${p.id}</div>
      <span class="badge ${p.connected ? 'badge-success' : 'badge-danger'}">${p.connected ? '在线' : '离线'}</span>
    </div>
  `).join('');
}

function renderQuestionsList() {
  const list = document.getElementById('questions-list');
  const empty = document.getElementById('q-empty');
  const badge = document.getElementById('q-count-badge');
  badge.textContent = `${admin.questions.length} 题`;
  if (admin.questions.length === 0) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  const labels = ['A', 'B', 'C', 'D'];
  list.innerHTML = admin.questions.map((q, i) => {
    const correctLabels = q.correctIndices.map(ci => labels[ci]).join(', ');
    return `<div class="question-item">
      <div class="question-num">${i + 1}</div>
      <div class="question-item-body">
        <div class="question-item-text">${escHtml(q.text)}</div>
        <div class="question-item-options">${q.options.map((o, oi) => `${labels[oi]}. ${escHtml(o)}`).join(' | ')}</div>
        <div class="question-item-correct">✅ 正确: ${correctLabels}</div>
      </div>
      <button class="btn btn-danger btn-icon btn-sm" onclick="deleteQuestion('${q.id}')">✕</button>
    </div>`;
  }).join('');
}

// ── Add question form ─────────────────────────────────────────────────────────
document.getElementById('btn-add-q-modal').addEventListener('click', () => {
  const form = document.getElementById('add-q-form');
  form.classList.toggle('hidden');
});

document.getElementById('btn-cancel-q').addEventListener('click', () => {
  document.getElementById('add-q-form').classList.add('hidden');
  clearAddQForm();
});

document.getElementById('btn-save-q').addEventListener('click', async () => {
  const text = document.getElementById('nq-text').value.trim();
  const opts = [
    document.getElementById('nq-a').value.trim(),
    document.getElementById('nq-b').value.trim(),
    document.getElementById('nq-c').value.trim(),
    document.getElementById('nq-d').value.trim(),
  ];
  const correctIndices = ['nq-ca', 'nq-cb', 'nq-cc', 'nq-cd']
    .map((id, i) => document.getElementById(id).checked ? i : -1)
    .filter(i => i >= 0);

  if (!text) { toast('请输入题目内容', 'error'); return; }
  const filledOpts = opts.filter(o => o !== '');
  if (filledOpts.length < 2) { toast('至少需要2个选项', 'error'); return; }
  if (correctIndices.length === 0) { toast('请选择至少一个正确答案', 'error'); return; }
  // Validate correct indices are within filled opts
  const filteredCorrect = correctIndices.filter(ci => opts[ci] !== '');
  if (filteredCorrect.length === 0) { toast('正确答案对应的选项不能为空', 'error'); return; }

  const options = opts.slice(0, filledOpts.length === 4 ? 4 : (opts[2] ? (opts[3] ? 4 : 3) : 2));
  const finalOpts = [];
  for (let i = 0; i < options.length; i++) {
    if (opts[i]) finalOpts.push(opts[i]);
    else break;
  }

  try {
    const res = await fetch(`/api/rooms/${admin.roomId}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: admin.password, text, options: finalOpts, correctIndices: filteredCorrect }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error, 'error'); return; }
    admin.questions = data.questions;
    renderQuestionsList();
    clearAddQForm();
    document.getElementById('add-q-form').classList.add('hidden');
    toast('题目已添加', 'success');
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
});

function clearAddQForm() {
  ['nq-text', 'nq-a', 'nq-b', 'nq-c', 'nq-d'].forEach(id => { document.getElementById(id).value = ''; });
  ['nq-ca', 'nq-cb', 'nq-cc', 'nq-cd'].forEach(id => { document.getElementById(id).checked = false; });
}

async function deleteQuestion(qid) {
  if (!confirm('确认删除该题目?')) return;
  try {
    const res = await fetch(`/api/rooms/${admin.roomId}/questions/${qid}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: admin.password }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error, 'error'); return; }
    admin.questions = data.questions;
    renderQuestionsList();
    toast('题目已删除', 'success');
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

// ── File import ───────────────────────────────────────────────────────────────
document.getElementById('inp-import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('adminPassword', admin.password);

  toast('正在导入文件…', 'info');
  try {
    const res = await fetch(`/api/rooms/${admin.roomId}/import`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error, 'error'); return; }
    admin.questions = data.questions;
    renderQuestionsList();
    toast(`成功导入 ${data.imported} 道题目`, 'success');
  } catch (err) {
    toast('导入失败: ' + err.message, 'error');
  }
  e.target.value = '';
});

// ── Lucky squares ─────────────────────────────────────────────────────────────
function renderLuckyTags() {
  const container = document.getElementById('lucky-tags');
  container.innerHTML = admin.pendingLucky.map(n =>
    `<div class="lucky-tag">${n} <button onclick="removeLucky(${n})">✕</button></div>`
  ).join('');
}

document.getElementById('btn-add-lucky').addEventListener('click', () => {
  const val = parseInt(document.getElementById('inp-lucky-num').value);
  if (isNaN(val) || val <= 0) { toast('请输入有效的格子编号', 'error'); return; }
  if (admin.pendingLucky.includes(val)) { toast('该格子已存在', 'error'); return; }
  admin.pendingLucky.push(val);
  admin.pendingLucky.sort((a, b) => a - b);
  renderLuckyTags();
  document.getElementById('inp-lucky-num').value = '';
});

window.removeLucky = function(n) {
  admin.pendingLucky = admin.pendingLucky.filter(x => x !== n);
  renderLuckyTags();
};

document.getElementById('btn-save-lucky').addEventListener('click', async () => {
  try {
    const res = await fetch(`/api/rooms/${admin.roomId}/lucky-squares`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: admin.password, squares: admin.pendingLucky }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error, 'error'); return; }
    admin.luckySquares = data.luckySquares;
    toast('幸运格已保存', 'success');
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────
document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const boardSize = document.getElementById('set-board-size').value;
  const timeLimit = document.getElementById('set-time-limit').value;
  try {
    const res = await fetch(`/api/rooms/${admin.roomId}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: admin.password, boardSize, timeLimit }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error, 'error'); return; }
    admin.boardSize = data.settings.boardSize;
    admin.timeLimit = data.settings.timeLimit;
    toast('设置已保存', 'success');
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
});

// ── Start game ────────────────────────────────────────────────────────────────
document.getElementById('btn-start-game').addEventListener('click', () => {
  if (admin.questions.length === 0) { toast('请先添加题目', 'error'); return; }
  if (Object.keys(admin.players).length === 0) { toast('没有玩家加入', 'error'); return; }
  if (!confirm('确认开始游戏?')) return;
  socket.emit('admin:start-game');
});

// ── PLAYING VIEW ──────────────────────────────────────────────────────────────
function renderPlaying() {
  updatePlayingRoomInfo();
  renderAdminBoard();
  renderAdminScoreboard();
  document.getElementById('btn-next-q').disabled = (admin.gameState !== 'ready');
}

function updatePlayingRoomInfo() {
  document.getElementById('playing-room-info').textContent = `房间: ${admin.roomId} | 玩家: ${Object.keys(admin.players).length}`;
  document.getElementById('playing-round').textContent = `第 ${admin.roundNumber} 题`;
}

function renderAdminBoard() {
  Board.render('admin-board', admin.boardSize, admin.luckySquares, admin.players, null);
}

function renderAdminScoreboard() {
  Board.renderMiniScoreboard('admin-scoreboard', admin.players, admin.boardSize, null);
}

// ── Next question ─────────────────────────────────────────────────────────────
document.getElementById('btn-next-q').addEventListener('click', () => {
  document.getElementById('btn-next-q').disabled = true;
  document.getElementById('admin-q-card').classList.add('hidden');
  document.getElementById('no-questions-alert').classList.add('hidden');
  socket.emit('admin:next-question');
});

function showAdminQuestion(question, timeLimit) {
  const card = document.getElementById('admin-q-card');
  card.classList.remove('hidden');
  const labels = ['A', 'B', 'C', 'D'];
  document.getElementById('admin-q-round').textContent = `第 ${admin.roundNumber} 题`;
  document.getElementById('admin-q-text').textContent = question.text;
  document.getElementById('admin-q-options').innerHTML = question.options
    .map((o, i) => `<span style="margin-right:0.75rem;">${labels[i]}. ${escHtml(o)}</span>`)
    .join('');
  document.getElementById('admin-q-answer').textContent = '';
  document.getElementById('admin-countdown-display').textContent = `⏱️ ${timeLimit}s`;
}

function startAdminCountdown(total) {
  stopAdminCountdown();
  let left = total;
  const el = document.getElementById('admin-countdown-display');
  state_adminLeft = left;
  admin.countdownInterval = setInterval(() => {
    left--;
    if (el) el.textContent = `⏱️ ${left}s`;
    if (left <= 0) stopAdminCountdown();
  }, 1000);
}

function stopAdminCountdown() {
  if (admin.countdownInterval) {
    clearInterval(admin.countdownInterval);
    admin.countdownInterval = null;
  }
}

// ── Round results ─────────────────────────────────────────────────────────────
function renderRoundResults(data) {
  const list = document.getElementById('round-results-list');
  const labels = ['A', 'B', 'C', 'D'];
  const correctLabels = data.correctIndices.map(i => labels[i]).join(', ');

  list.innerHTML = `
    <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.4rem;">
      正确答案: <b style="color:var(--success);">${correctLabels}</b>
    </div>` +
    Object.entries(data.results).map(([uid, r]) => {
      const icon = !r.answered ? '⏱️' : r.correct ? '✅' : '❌';
      let detail = '';
      if (!r.answered) detail = '超时';
      else if (r.correct) detail = `+${r.dice} → 格${r.newPos}`;
      else detail = `停留格${r.oldPos}`;
      return `<div class="result-row">
        <span class="result-icon">${icon}</span>
        <div class="token" style="background:${Board.playerColor(uid)};">${Board.initials(uid)}</div>
        <span class="result-name">${uid}</span>
        <span class="result-detail">${detail}${r.hitLucky ? ' ⭐' : ''}${r.justFinished ? ' 🏁' : ''}</span>
      </div>`;
    }).join('');
}

// ── End game ──────────────────────────────────────────────────────────────────
document.getElementById('btn-end-game').addEventListener('click', () => {
  if (!confirm('确认结束游戏?')) return;
  socket.emit('admin:end-game');
});

// ── Game over ─────────────────────────────────────────────────────────────────
function renderAdminGameOver(data) {
  const lbEl = document.getElementById('admin-final-leaderboard');
  const rankEmojis = ['🥇', '🥈', '🥉'];
  lbEl.innerHTML = data.leaderboard.map((entry, i) => {
    const rankDisplay = rankEmojis[i] || `#${entry.rank}`;
    return `<div class="lb-row ${i < 3 ? 'top' + (i + 1) : ''}">
      <div class="lb-rank">${rankDisplay}</div>
      <div class="token" style="background:${Board.playerColor(entry.id)};">${Board.initials(entry.id)}</div>
      <div class="lb-name">${entry.id}</div>
      <div class="lb-detail">${entry.finished ? '🏁 完赛' : `位置 ${entry.position}`}${entry.luckyCount > 0 ? ` ⭐×${entry.luckyCount}` : ''}</div>
    </div>`;
  }).join('');

  if (data.luckyPlayers && data.luckyPlayers.length > 0) {
    document.getElementById('admin-lucky-section').classList.remove('hidden');
    document.getElementById('admin-lucky-list').innerHTML = data.luckyPlayers.map(p =>
      `<div class="lb-row">
        <div class="token" style="background:${Board.playerColor(p.id)};">${Board.initials(p.id)}</div>
        <div class="lb-name">${p.id}</div>
        <div class="lb-detail">⭐ 幸运格 ×${p.luckyCount}</div>
      </div>`
    ).join('');
  }
}

document.getElementById('btn-new-game').addEventListener('click', () => {
  location.reload();
});

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
