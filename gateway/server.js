/**
 * server.js — Gateway Service  (Multi-Tenant Edition)
 *
 * Responsibilities:
 *  ✓ Accept WebSocket connections from browser clients
 *  ✓ boardClients: Map<boardId, Set<ws>> — board-scoped WS channels
 *  ✓ On 'join-board' message: register client in board room, send full-sync for that board
 *  ✓ On 'stroke' message: forward to Leader with boardId via leaderTracker
 *  ✓ On 'ping': pong back
 *  ✓ On WS close/error: remove from all board rooms
 *  ✓ POST /broadcast: { boardId, stroke } → push only to boardClients[boardId]
 *  ✓ GET  /health: liveness + leader + boardCount + totalClients + failoverActive
 *
 *  ✓ GRACEFUL FAILOVER — preserved from Week 2:
 *      - leaderTracker queues strokes and replays once a new leader is found
 *      - 'leader-changing' / 'leader-restored' broadcast to ALL clients (global event)
 *
 * WebSocket Message Shapes:
 *
 *  Client → Gateway:
 *    { type: "join-board", boardId }                           ← NEW
 *    { type: "stroke", boardId, data: { points, color, width } }
 *    { type: "ping" }
 *
 *  Gateway → Client:
 *    { type: "full-sync",        boardId, data: { strokes: [] } }    ← NEW: scoped
 *    { type: "stroke-committed", boardId, data: { index, ... } }     ← NEW: scoped
 *    { type: "user-count",       boardId, count }                    ← NEW
 *    { type: "leader-changing",  data: { message } }
 *    { type: "leader-restored",  data: { leader } }
 *    { type: "pong" }
 *    { type: "error",            data: { message } }
 */

const express       = require('express');
const http          = require('http');
const { WebSocketServer, OPEN } = require('ws');
const leaderTracker = require('./leaderTracker');

// ── Structured logger ─────────────────────────────────────────────────────────
const _ts    = () => new Date().toISOString();
const ginfo  = (msg) => console.log(`${_ts()} [INFO ][Gateway] ${msg}`);
const gwarn  = (msg) => console.warn(`${_ts()} [WARN ][Gateway] ${msg}`);
const gerror = (msg) => console.error(`${_ts()} [ERROR][Gateway] ${msg}`);

// ── Express + HTTP + WebSocket setup ──────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Board-scoped client registry ──────────────────────────────────────────────
/**
 * boardClients: Map<boardId, Set<ws>>
 *
 * Each ws is also augmented with:
 *   ws.id      — monotonic counter for logging
 *   ws.boardId — the board this client has joined (null until join-board received)
 */
const boardClients  = new Map();   // boardId → Set<ws>
let clientIdCounter = 0;

const DEFAULT_BOARD = 'board-public';

/** Ensure the board room exists and return its Set<ws>. */
function _getRoom(boardId) {
  if (!boardClients.has(boardId)) {
    boardClients.set(boardId, new Set());
  }
  return boardClients.get(boardId);
}

/** Add a client to a board room; remove from previous room if switching. */
function _joinRoom(ws, boardId) {
  // Remove from old room
  if (ws.boardId && ws.boardId !== boardId) {
    const oldRoom = boardClients.get(ws.boardId);
    if (oldRoom) {
      oldRoom.delete(ws);
      _broadcastUserCount(ws.boardId);
    }
  }
  ws.boardId = boardId;
  _getRoom(boardId).add(ws);
  _broadcastUserCount(boardId);
}

/** Remove a client from its board room. */
function _leaveRoom(ws) {
  if (!ws.boardId) return;
  const room = boardClients.get(ws.boardId);
  if (room) {
    room.delete(ws);
    _broadcastUserCount(ws.boardId);
    if (room.size === 0) {
      // Optionally keep the room alive for re-joins: do NOT delete map entry
      // so the log is preserved. If we wanted to GC empty rooms we'd delete here.
    }
  }
}

/** Send a JSON message to a single WebSocket client (safe — checks OPEN state). */
function sendToClient(ws, payload) {
  if (ws.readyState === OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/** Broadcast a JSON message to all clients in a specific board room. */
function broadcastToBoard(boardId, payload) {
  const room = boardClients.get(boardId);
  if (!room) return 0;
  const msg = JSON.stringify(payload);
  let sent = 0;
  for (const ws of room) {
    if (ws.readyState === OPEN) {
      ws.send(msg);
      sent++;
    }
  }
  return sent;
}

/** Broadcast a JSON message to ALL connected clients (global events: failover). */
function broadcastAll(payload) {
  const msg = JSON.stringify(payload);
  let sent = 0;
  for (const room of boardClients.values()) {
    for (const ws of room) {
      if (ws.readyState === OPEN) {
        ws.send(msg);
        sent++;
      }
    }
  }
  // Also send to unjoined clients (those still in the lobby / not in any room)
  for (const ws of unjoinedClients) {
    if (ws.readyState === OPEN) {
      ws.send(msg);
      sent++;
    }
  }
  return sent;
}

/**
 * unjoinedClients: Set<ws>
 * Clients that have connected but not yet sent join-board.
 * They receive failover broadcasts but no board-specific messages.
 */
const unjoinedClients = new Set();

/** Push user-count update to all clients in a board room. */
function _broadcastUserCount(boardId) {
  const room  = boardClients.get(boardId);
  const count = room ? room.size : 0;
  broadcastToBoard(boardId, { type: 'user-count', boardId, count });
}

// ── Full-sync helper ──────────────────────────────────────────────────────────
const axios = require('axios');

const FULL_SYNC_RETRY_WAIT_MS  = 1500;
const FULL_SYNC_RETRY_ATTEMPTS = 2;

/**
 * Ask the leader for the committed log of a specific board and send it to the client.
 * Calls GET /committed-log?boardId=X on the leader.
 */
async function sendFullSync(ws, boardId) {
  const bid = boardId || DEFAULT_BOARD;

  for (let attempt = 1; attempt <= FULL_SYNC_RETRY_ATTEMPTS; attempt++) {
    const leaderUrl = leaderTracker.getLeader();

    if (!leaderUrl) {
      if (attempt < FULL_SYNC_RETRY_ATTEMPTS) {
        gwarn(
          `Full-sync attempt ${attempt} for client #${ws.id} (board=${bid}): no leader yet — ` +
          `waiting ${FULL_SYNC_RETRY_WAIT_MS}ms`
        );
        await new Promise(r => setTimeout(r, FULL_SYNC_RETRY_WAIT_MS));
        continue;
      }
      sendToClient(ws, { type: 'full-sync', boardId: bid, data: { strokes: [] } });
      gwarn(`Full-sync: no leader — sent empty sync to client #${ws.id} (board=${bid})`);
      return;
    }

    try {
      const logRes  = await axios.get(`${leaderUrl}/committed-log`, {
        params:  { boardId: bid },
        timeout: 2000,
      });
      const strokes = logRes.data.strokes || [];
      sendToClient(ws, { type: 'full-sync', boardId: bid, data: { strokes } });
      ginfo(
        `Full-sync → client #${ws.id} (board=${bid}): ${strokes.length} stroke(s) from ${leaderUrl}` +
        (attempt > 1 ? ` (attempt ${attempt})` : '')
      );
      return;
    } catch (err) {
      gwarn(`Full-sync attempt ${attempt} failed for client #${ws.id} (board=${bid}): ${err.message}`);
      if (attempt < FULL_SYNC_RETRY_ATTEMPTS) {
        await new Promise(r => setTimeout(r, FULL_SYNC_RETRY_WAIT_MS));
      }
    }
  }

  sendToClient(ws, { type: 'full-sync', boardId: bid, data: { strokes: [] } });
  gwarn(`Full-sync: all attempts failed for client #${ws.id} (board=${bid}) — sent empty sync`);
}

// ── WebSocket event handling ───────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  ws.id     = ++clientIdCounter;
  ws.boardId = null;
  unjoinedClients.add(ws);

  const clientIp = req.socket.remoteAddress || 'unknown';
  ginfo(`Client #${ws.id} connected from ${clientIp}`);

  // Inform newly connected client if a failover is in progress
  if (leaderTracker.isFailoverInProgress()) {
    sendToClient(ws, {
      type: 'leader-changing',
      data: { message: 'Leader election in progress — strokes will be delivered shortly' },
    });
  }

  // ── Incoming messages from client ────────────────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      gwarn(`Client #${ws.id} sent invalid JSON — ignored`);
      sendToClient(ws, { type: 'error', data: { message: 'Invalid JSON' } });
      return;
    }

    switch (msg.type) {

      // ── join-board: client enters a room and gets full-sync ────────────
      case 'join-board': {
        const boardId = (msg.boardId || DEFAULT_BOARD).trim().slice(0, 64);
        unjoinedClients.delete(ws);
        _joinRoom(ws, boardId);
        ginfo(`Client #${ws.id} joined board "${boardId}" — room size: ${_getRoom(boardId).size}`);
        sendFullSync(ws, boardId);
        break;
      }

      // ── stroke: forward to leader with boardId ─────────────────────────
      case 'stroke': {
        if (!msg.data || !Array.isArray(msg.data.points) || msg.data.points.length === 0) {
          sendToClient(ws, { type: 'error', data: { message: 'Invalid stroke payload' } });
          return;
        }
        const boardId = msg.boardId || ws.boardId || DEFAULT_BOARD;
        ginfo(`Client #${ws.id} sent stroke (board=${boardId}) — forwarding to leader`);
        leaderTracker.forwardStroke(msg.data, boardId).catch((err) => {
          gerror(`forwardStroke error (board=${boardId}): ${err.message}`);
        });
        break;
      }

      case 'ping':
        sendToClient(ws, { type: 'pong' });
        break;

      default:
        gwarn(`Client #${ws.id} sent unknown message type: "${msg.type}"`);
    }
  });

  // ── Connection closed ────────────────────────────────────────────────
  ws.on('close', (code, reason) => {
    unjoinedClients.delete(ws);
    _leaveRoom(ws);
    const reasonStr = reason && reason.length > 0 ? reason.toString() : 'none';
    ginfo(
      `Client #${ws.id} disconnected (board=${ws.boardId || 'none'})` +
      ` (code=${code}, reason=${reasonStr})`
    );
  });

  // ── Connection error ─────────────────────────────────────────────────
  ws.on('error', (err) => {
    gerror(`Client #${ws.id} socket error: ${err.message}`);
    unjoinedClients.delete(ws);
    _leaveRoom(ws);
  });
});

// ── HTTP: Leader → Gateway → Board clients ────────────────────────────────────
/**
 * POST /broadcast
 * Called by the Leader after committing a log entry.
 * Body: { boardId, stroke: { index, points, color, width, ... } }
 *
 * Pushes the committed stroke ONLY to clients on the matching board.
 * Also sends a user-count update for the board.
 */
app.post('/broadcast', (req, res) => {
  const { boardId, stroke } = req.body;
  const bid = boardId || DEFAULT_BOARD;

  if (!stroke || stroke.index === undefined) {
    return res.status(400).json({ success: false, error: 'Missing stroke or stroke.index' });
  }

  const sent = broadcastToBoard(bid, { type: 'stroke-committed', boardId: bid, data: stroke });

  ginfo(`/broadcast board=${bid} — index=${stroke.index} — pushed to ${sent} client(s)`);

  res.json({ success: true, boardId: bid, clientsNotified: sent });
});

// ── HTTP: Health / Status ─────────────────────────────────────────────────────
/**
 * GET /health
 * Returns gateway liveness, currently tracked leader URL, board count,
 * total connected clients, queue depth, and failover state.
 */
app.get('/health', (req, res) => {
  const stats = leaderTracker.getStats();

  let totalClients = unjoinedClients.size;
  for (const room of boardClients.values()) totalClients += room.size;

  res.json({
    status:        'ok',
    leader:        stats.leader,
    clients:       totalClients,
    boardCount:    boardClients.size,
    queueDepth:    stats.queueDepth,
    failoverActive: stats.failoverActive,
  });
});

app.get('/status', (req, res) => {
  const stats = leaderTracker.getStats();

  let totalClients = unjoinedClients.size;
  for (const room of boardClients.values()) totalClients += room.size;

  res.json({
    status:        'ok',
    leader:        stats.leader,
    clients:       totalClients,
    boardCount:    boardClients.size,
    queueDepth:    stats.queueDepth,
    failoverActive: stats.failoverActive,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

leaderTracker.onLeaderChange((newLeader, prevLeader) => {
  if (newLeader) {
    ginfo(`Leader changed: ${prevLeader || 'none'} → ${newLeader}`);
  } else {
    gwarn(`Leader lost (was ${prevLeader}) — strokes will be queued`);
  }
});

leaderTracker.onFailoverStateChange((isActive) => {
  if (isActive) {
    ginfo('⚡ Failover started — broadcasting leader-changing to all clients');
    broadcastAll({
      type: 'leader-changing',
      data: { message: 'Leader election in progress — your strokes are safely queued' },
    });
  } else {
    const newLeader = leaderTracker.getLeader();
    ginfo(`✅ Failover complete — broadcasting leader-restored (${newLeader})`);
    broadcastAll({
      type: 'leader-restored',
      data: { leader: newLeader },
    });
  }
});

server.listen(PORT, () => {
  console.log(`${_ts()} [INFO ][Gateway] ── WebSocket Gateway starting ────────────────────`);
  console.log(`${_ts()} [INFO ][Gateway]    HTTP + WS port : ${PORT}`);
  console.log(`${_ts()} [INFO ][Gateway]    Replicas       : ${process.env.REPLICAS || '(default)'}`);
  console.log(`${_ts()} [INFO ][Gateway] ────────────────────────────────────────────`);
  leaderTracker.start();
});
