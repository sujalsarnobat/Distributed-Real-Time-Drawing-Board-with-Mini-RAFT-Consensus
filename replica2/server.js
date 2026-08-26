/**
 * server.js — Replica HTTP Server  (Multi-Tenant Edition)
 *
 * Exposes all RAFT RPC endpoints and starts the RAFT state machine.
 *
 * Multi-tenant change: boardId is threaded through client-stroke, committed-log,
 * append-entries, and sync-log so each board's log is managed independently.
 *
 * Endpoints:
 *  POST /request-vote    — Candidate requests vote from peer
 *  POST /append-entries  — Leader replicates a log entry to follower (boardId in body)
 *  POST /heartbeat       — Leader heartbeat; carries per-board commitIndex map
 *  POST /sync-log        — Leader sends missing entries to lagging follower (boardId in body)
 *  POST /client-stroke   — Gateway forwards a client stroke (boardId in body, Leader only)
 *  GET  /status          — Current RAFT state: { id, state, term, leader, logLength, commitIndex, boards }
 *  GET  /committed-log   — Committed strokes for a board (?boardId=X, default: board-public)
 *
 * [OBS-4] Unknown routes return a JSON 404 (not Express's default HTML).
 */

const express = require('express');
const raft    = require('./raft');
const config  = require('./config');

const app = express();
app.use(express.json());

// ── RAFT RPC Endpoints ────────────────────────────────────────────────────────

app.post('/request-vote', (req, res) => {
  const result = raft.handleRequestVote(req.body);
  res.json(result);
});

// boardId is included in body — raft.js routes to correct board log
app.post('/append-entries', (req, res) => {
  const result = raft.handleAppendEntries(req.body);
  res.json(result);
});

app.post('/heartbeat', (req, res) => {
  const result = raft.handleHeartbeat(req.body);
  res.json(result);
});

// boardId is included in body
app.post('/sync-log', (req, res) => {
  const result = raft.handleSyncLog(req.body);
  res.json(result);
});

// ── Client Stroke (from Gateway) ──────────────────────────────────────────────

/**
 * POST /client-stroke
 * Body: { boardId, stroke: { points, color, width } }
 * boardId defaults to 'board-public' if omitted (free-draw mode).
 */
app.post('/client-stroke', async (req, res) => {
  const { stroke, boardId } = req.body;
  const result = await raft.handleClientStroke(stroke, boardId);
  res.json(result);
});

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * GET /status
 * Returns: { id, state, term, leader, logLength, commitIndex, boards }
 * 'boards' maps boardId → { logLength, commitIndex } for observability.
 */
app.get('/status', (req, res) => {
  res.json(raft.getStatus());
});

// ── Committed Log (for Gateway full-sync) ─────────────────────────────────────

/**
 * GET /committed-log?boardId=X
 * Returns all committed stroke entries for the given board.
 * boardId defaults to 'board-public' if omitted.
 * Response: { strokes: [ { index, points, color, width, ... } ] }
 */
app.get('/committed-log', (req, res) => {
  const boardId = req.query.boardId || 'board-public';
  const strokes = raft.getCommittedLog(boardId);
  res.json({ strokes });
});

// ── 404 catch-all ────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((req, res) => {
  const ts = new Date().toISOString();
  console.log(
    `${ts} [WARN ][${config.REPLICA_ID}] 404 ${req.method} ${req.path}`
  );
  res.status(404).json({ success: false, error: `Unknown route: ${req.method} ${req.path}` });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.PORT, () => {
  console.log(`[${config.REPLICA_ID}] HTTP server listening on port ${config.PORT}`);
  raft.start();
});
