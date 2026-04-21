/**
 * app.js — Mini-RAFT Drawing Board Frontend  (Multi-Tenant Edition)
 *
 * Architecture:
 *   Lobby Screen  →  user picks Create / Join / Free-Draw
 *   Board Screen  →  canvas + toolbar for a specific boardId
 *
 * Pipeline (unchanged from Week 2, now board-scoped):
 *   User draws  →  points collected on live canvas layer
 *   onPointerUp →  decimated points sent as { type:"stroke", boardId, data:{points,color,width} }
 *   Gateway     →  forwards to RAFT Leader via POST /client-stroke (boardId in body)
 *   Leader      →  AppendEntries to majority → commit → POST /broadcast { boardId, stroke }
 *   Gateway     →  broadcastToBoard(boardId) → { type:"stroke-committed", boardId, data:{...} }
 *   Frontend    →  receives stroke-committed (guards boardId), deduplicates, redraws
 *
 * New in this edition:
 *  - generateBoardId()   — 6-char alphanumeric Room ID (e.g. "Xk4f9P")
 *  - currentBoardId      — boardId for this tab's session
 *  - join-board handshake on WS open
 *  - All stroke messages carry boardId
 *  - full-sync and stroke-committed guarded by boardId match
 *  - user-count message updates per-board badge
 *  - Leave Room → return to lobby
 */

'use strict';

// ════════════════════════════════════════════════════════════════════════════
// LOBBY LOGIC
// ════════════════════════════════════════════════════════════════════════════

const lobbyScreen    = document.getElementById('lobby-screen');
const boardScreen    = document.getElementById('board-screen');
const generatedIdEl  = document.getElementById('generated-board-id');
const btnRegenId     = document.getElementById('btn-regenerate-id');
const btnCreateRoom  = document.getElementById('btn-create-room');
const joinInput      = document.getElementById('join-board-input');
const btnJoinRoom    = document.getElementById('btn-join-room');
const joinError      = document.getElementById('join-error');
const btnFreeDraw    = document.getElementById('btn-free-draw');
const btnLeaveRoom   = document.getElementById('btn-leave-room');
const roomIdDisplay  = document.getElementById('room-id-display');

/** Current board this tab is connected to. null = not yet joined. */
let currentBoardId = null;

/** Generate a random 6-character alphanumeric Room ID. */
function generateBoardId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Refresh the displayed generated Room ID. */
function refreshGeneratedId() {
  generatedIdEl.textContent = generateBoardId();
}

/** Show the lobby and disconnect from any current board. */
function showLobby() {
  boardScreen.classList.add('board-screen-hidden');
  lobbyScreen.classList.remove('lobby-hidden');
  currentBoardId = null;
  // Intentionally close the WS on leave so the server cleans up the room
  if (ws) {
    isIntentionalClose = true;
    ws.close();
    isIntentionalClose = false;
    ws = null;
  }
  stopPing();
  committedStrokes.length = 0;
  pendingStrokes.length   = 0;
  refreshGeneratedId();
}

/** Enter the board screen for a given boardId. */
function enterBoard(boardId) {
  if (!boardId || !boardId.trim()) {
    showJoinError('Please enter a valid Room ID.');
    return;
  }
  currentBoardId = boardId.trim();
  roomIdDisplay.textContent = currentBoardId;
  hideJoinError();

  lobbyScreen.classList.add('lobby-hidden');
  boardScreen.classList.remove('board-screen-hidden');

  // Boot canvas + WS for this board
  resizeCanvas();
  updateBrushPreview();
  connect();
  startHealthPolling();
}

function showJoinError(msg) {
  joinError.textContent = msg;
  joinError.removeAttribute('hidden');
}
function hideJoinError() {
  joinError.textContent = '';
  joinError.setAttribute('hidden', '');
}

// ── Lobby event handlers ──────────────────────────────────────────────────────

btnRegenId.addEventListener('click', refreshGeneratedId);

btnCreateRoom.addEventListener('click', () => {
  enterBoard(generatedIdEl.textContent);
});

btnJoinRoom.addEventListener('click', () => {
  const id = joinInput.value.trim();
  if (!id) { showJoinError('Please enter a Room ID.'); return; }
  enterBoard(id);
});

joinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoinRoom.click();
});

btnFreeDraw.addEventListener('click', () => {
  enterBoard('board-public');
});

btnLeaveRoom.addEventListener('click', showLobby);

// Initialise the lobby with a fresh generated ID
refreshGeneratedId();

// ════════════════════════════════════════════════════════════════════════════
// CANVAS & DRAWING ENGINE
// ════════════════════════════════════════════════════════════════════════════

// ── DOM references ─────────────────────────────────────────────────────────
const canvas         = document.getElementById('drawing-canvas');
const ctx            = canvas.getContext('2d');
const statusEl       = document.getElementById('status-indicator');
const overlayEl      = document.getElementById('canvas-overlay');
const overlayMsgEl   = document.getElementById('overlay-message');
const overlaySubEl   = document.getElementById('overlay-sub');
const leaderNameEl   = document.getElementById('leader-name');
const countValueEl   = document.getElementById('count-value');
const queueDepthEl   = document.getElementById('queue-depth');
const toastContainer = document.getElementById('toast-container');
const brushSizeInput = document.getElementById('brush-size');
const brushPreviewEl = document.getElementById('brush-preview');
const btnClear       = document.getElementById('btn-clear');
const colourBtns     = document.querySelectorAll('.colour-btn');

// ── Canvas background colour ──────────────────────────────────────────────
const CANVAS_BG = '#f8f8f8';

// ── Drawing state ─────────────────────────────────────────────────────────
let isDrawing         = false;
let currentColor      = '#1e1e2e';
let brushSize         = 4;
let isEraser          = false;
let emittedAnySegment = false;
let lastEmittedPoint  = null;

// ── Point decimation ──────────────────────────────────────────────────────
const MIN_POINT_DISTANCE_PX = 3;

// ── Stroke stores ─────────────────────────────────────────────────────────
/** Committed strokes from the RAFT cluster (authoritative). */
const committedStrokes = [];
/** Locally-drawn strokes awaiting ack — cleared on reconnect. */
const pendingStrokes   = [];
let nextTempId = 1;

// ── Reconnection state ────────────────────────────────────────────────────
const GATEWAY_WS_URL  = `ws://${location.hostname}:3000`;
let ws                = null;
let reconnectTimer    = null;
let reconnectDelay    = 500;
const RECONNECT_MIN   = 500;
const RECONNECT_MAX   = 16_000;
let reconnectCount    = 0;
let isIntentionalClose = false;

/** Pre-sync buffer: stroke-committed messages arriving before full-sync. */
let pendingBroadcasts = [];

// ── Canvas utilities ──────────────────────────────────────────────────────

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width  = Math.floor(rect.width  * window.devicePixelRatio);
  canvas.height = Math.floor(rect.height * window.devicePixelRatio);
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  redrawAll();
}

window.addEventListener('resize', () => {
  if (currentBoardId) resizeCanvas();
});

function renderStroke(stroke, alpha = 1) {
  if (!stroke.points || stroke.points.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = stroke.color === 'eraser' ? CANVAS_BG : stroke.color;
  ctx.lineWidth   = stroke.width;
  const [first, ...rest] = stroke.points;
  ctx.moveTo(first.x, first.y);
  for (const pt of rest) ctx.lineTo(pt.x, pt.y);
  ctx.stroke();
  ctx.restore();
}

function redrawAll() {
  const cssW = canvas.width  / window.devicePixelRatio;
  const cssH = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, cssW, cssH);
  for (const stroke of committedStrokes) renderStroke(stroke);
  for (const stroke of pendingStrokes)   renderStroke(stroke, 0.45);
}

// ── Pointer events ────────────────────────────────────────────────────────

function eventToPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  return { x: src.clientX - rect.left, y: src.clientY - rect.top };
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function onPointerDown(e) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  e.preventDefault();
  isDrawing = true;
  emittedAnySegment = false;
  lastEmittedPoint  = null;

  const pt = eventToPoint(e);
  lastEmittedPoint = pt;

  ctx.save();
  ctx.beginPath();
  ctx.lineCap    = 'round';
  ctx.lineJoin   = 'round';
  ctx.strokeStyle = isEraser ? CANVAS_BG : currentColor;
  ctx.lineWidth  = brushSize;
  ctx.moveTo(pt.x, pt.y);
}

function onPointerMove(e) {
  if (!isDrawing) return;
  e.preventDefault();

  const pt = eventToPoint(e);
  const threshold2 = MIN_POINT_DISTANCE_PX * MIN_POINT_DISTANCE_PX;
  if (lastEmittedPoint && dist2(pt, lastEmittedPoint) < threshold2) return;

  const strokeData = {
    points: [lastEmittedPoint, pt],
    color:  isEraser ? 'eraser' : currentColor,
    width:  brushSize,
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    const tempId = nextTempId++;
    pendingStrokes.push({ tempId, ...strokeData });
    sendStroke(strokeData);
    emittedAnySegment = true;
  }

  lastEmittedPoint = pt;
  ctx.lineTo(pt.x, pt.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y);
}

function onPointerUp(e) {
  if (!isDrawing) return;
  e.preventDefault();
  ctx.restore();
  isDrawing = false;

  if (!emittedAnySegment && lastEmittedPoint) {
    const strokeData = {
      points: [lastEmittedPoint, { x: lastEmittedPoint.x + 0.5, y: lastEmittedPoint.y + 0.5 }],
      color:  isEraser ? 'eraser' : currentColor,
      width:  brushSize,
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      const tempId = nextTempId++;
      pendingStrokes.push({ tempId, ...strokeData });
      sendStroke(strokeData);
    }
  }

  lastEmittedPoint = null;
}

canvas.addEventListener('mousedown',  onPointerDown);
canvas.addEventListener('mousemove',  onPointerMove);
canvas.addEventListener('mouseup',    onPointerUp);
canvas.addEventListener('mouseleave', onPointerUp);
canvas.addEventListener('touchstart', onPointerDown, { passive: false });
canvas.addEventListener('touchmove',  onPointerMove, { passive: false });
canvas.addEventListener('touchend',   onPointerUp,   { passive: false });

// ════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CLIENT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Open a WebSocket connection to the Gateway and join the current board room.
 *
 * On open:   send { type:"join-board", boardId } to register in the board room.
 *            Gateway responds with full-sync for that board.
 * On message: route to handleMessage().
 * On close:   exponential backoff reconnect; re-join same boardId on next open.
 */
function connect() {
  if (!currentBoardId) return; // Don't connect until a board has been chosen

  if (ws) {
    isIntentionalClose = true;
    ws.close();
    isIntentionalClose = false;
    ws = null;
  }

  const isReconnect = reconnectCount > 0;
  setStatus('reconnecting', isReconnect ? 'Reconnecting…' : 'Connecting…');
  showOverlay(
    isReconnect
      ? `Reconnecting… (attempt ${reconnectCount})`
      : 'Connecting to server…',
    isReconnect ? 'Canvas will restore automatically' : ''
  );

  pendingBroadcasts = [];
  let fullSyncReceived = false;

  ws = new WebSocket(GATEWAY_WS_URL);

  ws.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MIN;
    console.log(`[WS] ${isReconnect ? 'Reconnected' : 'Connected'} — joining board "${currentBoardId}"`);
    // ── join-board handshake ──────────────────────────────────────────────
    ws.send(JSON.stringify({ type: 'join-board', boardId: currentBoardId }));
    startPing();
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { console.warn('[WS] Non-JSON message:', event.data); return; }

    // Guard: board-specific messages must match our board
    if (msg.boardId && msg.boardId !== currentBoardId) return;

    // Buffer stroke-committed messages arriving before full-sync
    if (msg.type === 'stroke-committed' && !fullSyncReceived) {
      pendingBroadcasts.push(msg.data);
      return;
    }

    if (msg.type === 'full-sync') {
      fullSyncReceived = true;
    }

    handleMessage(msg);
  });

  ws.addEventListener('close', (event) => {
    stopPing();
    if (isIntentionalClose) return;

    reconnectCount++;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);

    const wasConnected = statusEl.classList.contains('connected');
    setStatus('reconnecting', 'Reconnecting…');
    showOverlay(
      `Connection lost — reconnecting in ${Math.round(delay / 1000)}s…`,
      `Attempt ${reconnectCount} • Canvas will restore on reconnect`
    );

    if (wasConnected) {
      showToast('Connection lost — reconnecting…', 'warn', 4000);
    }

    console.log(
      `[WS] Closed (code=${event.code}). Retry #${reconnectCount} in ${delay}ms`
    );

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  });

  ws.addEventListener('error', () => {
    console.error('[WS] Socket error — waiting for close event to reconnect');
  });
}

// ── Incoming message router ───────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'full-sync': {
      const strokes = msg.data?.strokes || [];

      committedStrokes.length = 0;
      committedStrokes.push(...strokes);

      const hadPending = pendingStrokes.length;
      pendingStrokes.length = 0;

      // Drain buffered pre-sync broadcasts
      const committedSet = new Set(committedStrokes.map(s => s.index));
      for (const stroke of pendingBroadcasts) {
        if (!committedSet.has(stroke.index)) {
          committedStrokes.push(stroke);
          committedSet.add(stroke.index);
        }
      }
      committedStrokes.sort((a, b) => a.index - b.index);
      pendingBroadcasts = [];

      redrawAll();
      hideOverlay();
      setStatus('connected', 'Connected');

      const isReconnect = reconnectCount > 0;
      reconnectCount = 0;

      console.log(
        `[WS] Full-sync (board=${currentBoardId}): ${strokes.length} stroke(s)` +
        (isReconnect ? ' (reconnected — canvas restored)' : '')
      );

      if (hadPending > 0) {
        showToast(`${hadPending} in-flight stroke(s) may not have been committed — canvas re-synced`, 'warn', 5000);
      } else if (strokes.length > 0) {
        showToast(
          isReconnect
            ? `Canvas restored — ${strokes.length} stroke(s) loaded ✅`
            : `Canvas synced — ${strokes.length} stroke(s)`,
          isReconnect ? 'success' : 'info',
          3000
        );
      } else if (isReconnect) {
        showToast('Reconnected — board is empty (nothing drawn yet)', 'info', 2500);
      }
      break;
    }

    case 'stroke-committed': {
      const stroke = msg.data;
      if (committedStrokes.some(s => s.index === stroke.index)) break;
      if (pendingStrokes.length > 0) pendingStrokes.shift();
      committedStrokes.push(stroke);
      redrawAll();
      break;
    }

    // ── Per-board user count ──────────────────────────────────────────────
    case 'user-count': {
      if (countValueEl) countValueEl.textContent = msg.count ?? '–';
      break;
    }

    case 'pong':
      break;

    case 'error':
      console.warn('[WS] Server error:', msg.data?.message);
      showToast(msg.data?.message || 'Server error', 'error');
      break;

    case 'leader-changing':
      console.warn('[WS] Leader changing — election in progress');
      setFailoverIndicator(true);
      showToast('Leader election in progress — strokes are safely queued ⏳', 'warn', 5000);
      break;

    case 'leader-restored':
      console.log('[WS] Leader restored:', msg.data?.leader);
      setFailoverIndicator(false);
      updateLeaderBadge(msg.data?.leader || null);
      showToast('New leader elected — drawing resumed ✅', 'success', 3000);
      break;

    default:
      console.warn('[WS] Unknown message type:', msg.type);
  }
}

/** Send a stroke to the Gateway, tagged with the current boardId. */
function sendStroke(strokeData) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'stroke', boardId: currentBoardId, data: strokeData }));
}

// ── Keep-alive ping ───────────────────────────────────────────────────────────
let pingInterval = null;

function startPing() {
  stopPing();
  pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 20_000);
}

function stopPing() {
  clearInterval(pingInterval);
  pingInterval = null;
}

// ── Fast reconnect on visibility / network restore ────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentBoardId) {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      console.log('[WS] Tab became visible with dead socket — reconnecting immediately');
      clearTimeout(reconnectTimer);
      reconnectDelay = RECONNECT_MIN;
      connect();
    }
  }
});

window.addEventListener('online', () => {
  if (currentBoardId) {
    console.log('[WS] Network came online — reconnecting immediately');
    clearTimeout(reconnectTimer);
    reconnectDelay = RECONNECT_MIN;
    connect();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ════════════════════════════════════════════════════════════════════════════

function setStatus(cssClass, text) {
  statusEl.className   = `status ${cssClass}`;
  statusEl.textContent = text;
}

function setFailoverIndicator(isActive) {
  if (isActive) {
    setStatus('reconnecting', 'Electing…');
    if (queueDepthEl) {
      queueDepthEl.textContent = 'queued';
      queueDepthEl.classList.remove('hidden');
    }
  } else {
    if (ws && ws.readyState === WebSocket.OPEN) {
      setStatus('connected', 'Connected');
    }
    if (queueDepthEl) {
      queueDepthEl.classList.add('hidden');
    }
  }
}

function showOverlay(message, sub = '') {
  overlayMsgEl.textContent = message;
  if (overlaySubEl) overlaySubEl.textContent = sub;
  overlayEl.classList.remove('overlay-hidden');
  overlayEl.removeAttribute('aria-hidden');
}

function hideOverlay() {
  overlayEl.classList.add('overlay-hidden');
  overlayEl.setAttribute('aria-hidden', 'true');
}

function showToast(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className   = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function updateLeaderBadge(leaderUrl) {
  if (!leaderUrl) { leaderNameEl.textContent = '–'; return; }
  try {
    leaderNameEl.textContent = new URL(leaderUrl).hostname;
  } catch {
    leaderNameEl.textContent = leaderUrl;
  }
}

// ── Brush preview ─────────────────────────────────────────────────────────────
function updateBrushPreview() {
  const size  = Math.min(brushSize, 22);
  const color = isEraser ? '#aaa' : currentColor;
  brushPreviewEl.style.width      = `${size}px`;
  brushPreviewEl.style.height     = `${size}px`;
  brushPreviewEl.style.background = color;
  brushPreviewEl.style.border     = isEraser ? '1.5px dashed #666' : 'none';
}

// ── Poll Gateway /health for leader info + queue depth ─────────────────────────
let healthPollTimer = null;

function startHealthPolling() {
  if (healthPollTimer) return; // Already running
  const HEALTH_URL = `http://${location.hostname}:3000/health`;

  healthPollTimer = setInterval(async () => {
    if (!currentBoardId) return;
    try {
      const res  = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
      const data = await res.json();

      if (!data.failoverActive) {
        updateLeaderBadge(data.leader);
      }

      if (data.failoverActive) {
        setFailoverIndicator(true);
      } else if (statusEl.classList.contains('reconnecting') && ws && ws.readyState === WebSocket.OPEN) {
        setFailoverIndicator(false);
        updateLeaderBadge(data.leader);
      }

      if (queueDepthEl) {
        const depth = data.queueDepth ?? 0;
        if (depth > 0) {
          queueDepthEl.textContent = `${depth} queued`;
          queueDepthEl.classList.remove('hidden');
        } else if (!data.failoverActive) {
          queueDepthEl.classList.add('hidden');
        }
      }
    } catch (err) {
      console.debug(`[Health] Gateway poll failed: ${err.message}`);
    }
  }, 3000);
}

// ════════════════════════════════════════════════════════════════════════════
// TOOLBAR WIRE-UP
// ════════════════════════════════════════════════════════════════════════════

colourBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const colour = btn.dataset.colour;
    colourBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (colour === 'eraser') {
      isEraser = true;
    } else {
      isEraser     = false;
      currentColor = colour;
    }
    updateBrushPreview();
  });
});

brushSizeInput.addEventListener('input', () => {
  brushSize = parseInt(brushSizeInput.value, 10);
  updateBrushPreview();
});

btnClear.addEventListener('click', () => {
  committedStrokes.length = 0;
  pendingStrokes.length   = 0;
  const cssW = canvas.width  / window.devicePixelRatio;
  const cssH = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, cssW, cssH);
  showToast('Canvas cleared locally', 'info', 2000);
});

console.log('[Frontend] Mini-RAFT Drawing Board (multi-tenant) initialised');

// ════════════════════════════════════════════════════════════════════════════
// EXPORT  (PNG + PDF)
// ════════════════════════════════════════════════════════════════════════════

const exportGroup    = document.getElementById('export-group');
const exportBtn      = document.getElementById('btn-export');
const exportDropdown = document.getElementById('export-dropdown');
const exportPngBtn   = document.getElementById('btn-export-png');
const exportPdfBtn   = document.getElementById('btn-export-pdf');
const exportModal    = document.getElementById('export-modal');
const exportModalMsg = document.getElementById('export-modal-msg');

// ── Dropdown toggle ────────────────────────────────────────────────────────

function openExportDropdown() {
  exportDropdown.classList.add('open');
  exportBtn.classList.add('open');
  exportBtn.setAttribute('aria-expanded', 'true');
}

function closeExportDropdown() {
  exportDropdown.classList.remove('open');
  exportBtn.classList.remove('open');
  exportBtn.setAttribute('aria-expanded', 'false');
}

exportBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = exportDropdown.classList.contains('open');
  if (isOpen) {
    closeExportDropdown();
  } else {
    openExportDropdown();
  }
});

document.addEventListener('click', (e) => {
  if (!exportGroup.contains(e.target)) {
    closeExportDropdown();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeExportDropdown();
});

// ── Modal helpers ──────────────────────────────────────────────────────────

function showExportModal(message = 'Preparing export…') {
  exportModalMsg.textContent = message;
  exportModal.classList.remove('hidden');
}

function hideExportModal() {
  exportModal.classList.add('hidden');
}

// ── Snapshot helper ────────────────────────────────────────────────────────

function getBoardBlob() {
  return new Promise((resolve, reject) => {
    const offscreen = document.createElement('canvas');
    offscreen.width  = canvas.width;
    offscreen.height = canvas.height;

    const octx = offscreen.getContext('2d');

    octx.fillStyle = CANVAS_BG;
    octx.fillRect(0, 0, offscreen.width, offscreen.height);

    octx.save();
    octx.scale(window.devicePixelRatio, window.devicePixelRatio);
    for (const stroke of committedStrokes) {
      if (!stroke.points || stroke.points.length < 2) continue;
      octx.beginPath();
      octx.lineCap    = 'round';
      octx.lineJoin   = 'round';
      octx.strokeStyle = stroke.color === 'eraser' ? CANVAS_BG : stroke.color;
      octx.lineWidth  = stroke.width;
      const [first, ...rest] = stroke.points;
      octx.moveTo(first.x, first.y);
      for (const pt of rest) octx.lineTo(pt.x, pt.y);
      octx.stroke();
    }
    octx.restore();

    offscreen.toBlob((blob) => {
      if (blob) { resolve(blob); }
      else      { reject(new Error('Canvas toBlob returned null')); }
    }, 'image/png');
  });
}

// ── PNG export ─────────────────────────────────────────────────────────────

async function exportPNG() {
  closeExportDropdown();

  if (committedStrokes.length === 0 && pendingStrokes.length === 0) {
    showToast('Nothing to export — draw something first 🎨', 'warn', 3000);
    return;
  }

  showExportModal('Generating PNG…');

  try {
    const blob    = await getBoardBlob();
    const url     = URL.createObjectURL(blob);
    const anchor  = document.createElement('a');
    const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    anchor.href     = url;
    anchor.download = `mini-raft-board-${currentBoardId}-${ts}.png`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('PNG downloaded ✅', 'success', 3000);
  } catch (err) {
    console.error('[Export] PNG failed:', err);
    showToast('PNG export failed — see console for details', 'error');
  } finally {
    hideExportModal();
  }
}

// ── PDF export ─────────────────────────────────────────────────────────────

async function exportPDF() {
  closeExportDropdown();

  if (committedStrokes.length === 0 && pendingStrokes.length === 0) {
    showToast('Nothing to export — draw something first 🎨', 'warn', 3000);
    return;
  }

  showExportModal('Generating PDF…');

  try {
    const blob    = await getBoardBlob();
    const dataUrl = await blobToDataURL(blob);

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    const printWin = window.open('', '_blank', 'width=800,height=600');
    if (!printWin) {
      showToast('Pop-up blocked — please allow pop-ups for this page and retry', 'warn', 5000);
      return;
    }

    printWin.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Mini-RAFT Board ${currentBoardId} — ${ts}</title>
  <style>
    @page { margin: 0; size: auto; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #fff; }
    img {
      display: block;
      width: 100%;
      height: auto;
      max-height: 100vh;
      object-fit: contain;
      page-break-inside: avoid;
    }
  </style>
</head>
<body>
  <img src="${dataUrl}" alt="Mini-RAFT Drawing Board export"/>
  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); window.close(); }, 400);
    };
  <\/script>
</body>
</html>`);
    printWin.document.close();

    showToast('PDF print dialog opened 🖨️ — save as PDF', 'success', 5000);
  } catch (err) {
    console.error('[Export] PDF failed:', err);
    showToast('PDF export failed — see console for details', 'error');
  } finally {
    setTimeout(hideExportModal, 600);
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

exportPngBtn.addEventListener('click', exportPNG);
exportPdfBtn.addEventListener('click', exportPDF);
