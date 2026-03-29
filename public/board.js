/**
 * Board - shared board rendering module
 * Snake-pattern board like Monopoly/大富翁
 *
 * Layout (10 cols):
 *   Row 0 (bottom): positions 1-10, left to right
 *   Row 1: positions 11-20, right to left
 *   Row 2: positions 21-30, left to right
 *   etc.
 *   Position 0 = start zone below the board
 *   boardSize = finish square
 */
const Board = (() => {
  const COLS = 10;
  const CELL_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
    '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  ];
  const TOKEN_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
    '#FFEAA7', '#DDA0DD', '#F7DC6F', '#FF9F43',
    '#A29BFE', '#FD79A8', '#00CEC9', '#6C5CE7',
  ];

  // Map uid -> consistent color index
  const _colorCache = {};
  let _colorIdx = 0;

  function playerColor(uid) {
    if (!_colorCache[uid]) {
      _colorCache[uid] = TOKEN_COLORS[_colorIdx % TOKEN_COLORS.length];
      _colorIdx++;
    }
    return _colorCache[uid];
  }

  function initials(uid) {
    return String(uid).slice(0, 2).toUpperCase();
  }

  /**
   * Compute grid position (row, col) for a board position.
   * pos 1..boardSize => on the board
   * pos 0 => start zone
   * pos >= boardSize => finish (last cell)
   */
  function posToGrid(pos, boardSize) {
    if (pos <= 0) return null; // start zone
    const p = Math.min(pos, boardSize);
    const idx = p - 1; // 0-based
    const row = Math.floor(idx / COLS); // row from bottom (row 0 = bottom)
    const colFromLeft = idx % COLS;
    // Snake: even rows go left-to-right, odd rows go right-to-left
    const col = (row % 2 === 0) ? colFromLeft : (COLS - 1 - colFromLeft);
    return { row, col };
  }

  /**
   * Render the board into a container element.
   * @param {string} containerId
   * @param {number} boardSize
   * @param {number[]} luckySquares
   * @param {Object} players - map uid -> {id, position, finished, ...}
   * @param {string|null} myUid - highlight this player's token
   */
  function render(containerId, boardSize, luckySquares, players, myUid) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const numRows = Math.ceil(boardSize / COLS);

    // Build a 2D grid: rows (top to bottom in display), cols
    // Display: top row = highest positions
    // grid[displayRow][col] => board position
    const grid = [];
    for (let r = numRows - 1; r >= 0; r--) {
      const rowCells = [];
      for (let c = 0; c < COLS; c++) {
        // r = 0 is the bottom row (positions 1-10)
        // display order: highest row first
        const colFromLeft = (r % 2 === 0) ? c : (COLS - 1 - c);
        const pos = r * COLS + colFromLeft + 1;
        rowCells.push(pos <= boardSize ? pos : null);
      }
      grid.push(rowCells);
    }

    // Build player position map: pos -> [uids]
    const posMap = {};
    for (const [uid, p] of Object.entries(players)) {
      const pos = Math.min(p.position, boardSize);
      if (!posMap[pos]) posMap[pos] = [];
      posMap[pos].push(uid);
    }

    let html = `<div class="board-grid" id="board-grid-inner" style="grid-template-columns: repeat(${COLS}, 1fr);">`;

    for (const row of grid) {
      for (const pos of row) {
        if (pos === null) {
          html += `<div class="cell" style="background:transparent;border:none;"></div>`;
          continue;
        }
        const isLucky = luckySquares.includes(pos);
        const isFinish = (pos === boardSize);
        const colorBase = CELL_COLORS[(pos - 1) % CELL_COLORS.length];
        const bg = isLucky
          ? 'rgba(255,215,0,0.22)'
          : isFinish
          ? 'rgba(159,110,245,0.18)'
          : hexToRgba(colorBase, 0.18);
        const borderColor = isLucky ? '#FFD700' : isFinish ? '#9f6ef5' : hexToRgba(colorBase, 0.4);

        const tokensHere = posMap[pos] || [];
        let tokensHtml = '';
        if (tokensHere.length > 0) {
          tokensHtml = `<div class="cell-tokens">` +
            tokensHere.map(uid => {
              const isMe = uid === myUid;
              return `<div class="token${isMe ? ' me' : ''}" style="background:${playerColor(uid)};" title="${uid}">${initials(uid)}</div>`;
            }).join('') +
            `</div>`;
        }

        html += `<div class="cell${isLucky ? ' lucky' : ''}${isFinish ? ' finish' : ''}"
          id="cell-${pos}"
          style="background:${bg};border-color:${borderColor};">
          <div class="cell-num">${pos}</div>
          ${tokensHtml}
        </div>`;
      }
    }

    html += `</div>`;

    // Start zone
    const startPlayers = posMap[0] || [];
    let startHtml = `<div class="board-start-zone" id="start-zone">
      <span class="board-start-label">START</span>`;
    for (const uid of startPlayers) {
      const isMe = uid === myUid;
      startHtml += `<div class="token${isMe ? ' me' : ''}" style="background:${playerColor(uid)};" title="${uid}">${initials(uid)}</div>`;
    }
    startHtml += `</div>`;

    container.innerHTML = html + startHtml;
  }

  /**
   * Animate step-by-step movement of a player from fromPos to toPos.
   * Re-renders at each step with 200ms delay.
   * onStep(pos) called at each position
   * onDone() called when animation ends
   */
  function animateMovement(uid, fromPos, toPos, boardSize, luckySquares, players, myUid, containerId, onStep, onDone) {
    if (fromPos === toPos) {
      if (onDone) onDone();
      return;
    }
    const step = toPos > fromPos ? 1 : -1; // should always be +1 but handle edge case
    let cur = fromPos;

    function next() {
      cur += step;
      // Update player position in local players object for rendering
      if (players[uid]) players[uid].position = cur;
      render(containerId, boardSize, luckySquares, players, myUid);
      // Highlight cell
      const cell = document.getElementById('cell-' + Math.min(cur, boardSize));
      if (cell) {
        cell.classList.add('highlight-move');
        setTimeout(() => cell.classList.remove('highlight-move'), 300);
      }
      if (onStep) onStep(cur);
      if (cur < toPos) {
        setTimeout(next, 220);
      } else {
        if (onDone) setTimeout(onDone, 100);
      }
    }
    setTimeout(next, 100);
  }

  /**
   * Trigger lucky burst animation on a cell.
   */
  function triggerLuckyAnimation(position) {
    const cell = document.getElementById('cell-' + position);
    if (!cell) return;
    cell.classList.remove('lucky-burst');
    // Force reflow
    void cell.offsetWidth;
    cell.classList.add('lucky-burst');
    setTimeout(() => cell.classList.remove('lucky-burst'), 900);
  }

  /**
   * Render a mini scoreboard sorted by position (desc).
   * @param {string} containerId
   * @param {Object} players
   * @param {number} boardSize
   * @param {string|null} myUid
   */
  function renderMiniScoreboard(containerId, players, boardSize, myUid) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const sorted = Object.values(players).sort((a, b) => {
      if (a.finished && !b.finished) return -1;
      if (!a.finished && b.finished) return 1;
      if (a.finished && b.finished) return (a.finishOrder || 999) - (b.finishOrder || 999);
      return b.position - a.position;
    });

    let html = '';
    sorted.forEach((p, i) => {
      const rank = i + 1;
      const isMe = p.id === myUid;
      const rankEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
      const posDisplay = p.finished ? `<span class="finished-badge">FINISH</span>` : `pos ${p.position}`;
      html += `<div class="score-row${isMe ? ' me' : ''}">
        <div class="rank">${rankEmoji}</div>
        <div class="token" style="background:${playerColor(p.id)};">${initials(p.id)}</div>
        <div class="score-name" title="${p.id}">${p.id}</div>
        <div class="score-pos">${posDisplay}</div>
      </div>`;
    });

    container.innerHTML = html;
  }

  // Utility: hex color to rgba string
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  return { render, playerColor, initials, animateMovement, triggerLuckyAnimation, renderMiniScoreboard };
})();
