/**
 * raft.js — Mini-RAFT State Machine  (Multi-Tenant Edition)
 *
 * States: Follower | Candidate | Leader
 *
 * Multi-tenant changes (Week 3):
 *  ✓ boardLogs: Map<boardId, StrokeLog>   — one log per board (lazy-initialised)
 *  ✓ boardCommitIndex: Map<boardId, number> — one commitIndex per board
 *  ✓ handleClientStroke(stroke, boardId)  — board-scoped append + replication
 *  ✓ handleAppendEntries/handleSyncLog    — route by boardId
 *  ✓ handleHeartbeat                      — advances per-board commitIndex
 *  ✓ notifyGateway(entry, boardId)        — POST /broadcast with boardId
 *  ✓ getCommittedLog(boardId)             — returns committed strokes for one board
 *  ✓ _lastIndex(boardId) / _lastTerm(boardId) — board-scoped log helpers
 *
 * All RAFT correctness (election, term checks, log safety) is unchanged.
 *
 * Fix log (audit):
 *  [BUG-2] sendHeartbeats: parallel Promise.allSettled (no false elections)
 *  [BUG-1] leaderCommit in AppendEntries uses post-commit entry.index
 *  [OBS-1] ISO-8601 timestamps on all log lines
 *  [OBS-2] Explicit [INFO] / [WARN] / [ERROR] severity tags
 *  [OBS-7] sendHeartbeats emits a summary when any peer is lagging
 */

const axios      = require('axios');
const config     = require('./config');
const StrokeLog  = require('./log');  // class, not singleton

// ── Structured logger ─────────────────────────────────────────────────────────
const _ts = () => new Date().toISOString();

const LEVELS = {
  DEBUG: 10,
  INFO:  20,
  WARN:  30,
  ERROR: 40,
};

const ACTIVE_LOG_LEVEL = LEVELS[config.LOG_LEVEL] ? config.LOG_LEVEL : 'INFO';

function _log(level, msg) {
  if (LEVELS[level] < LEVELS[ACTIVE_LOG_LEVEL]) return;
  console.log(`${_ts()} [${level.padEnd(5)}][RAFT][${config.REPLICA_ID}] ${msg}`);
}

const debug = (msg) => _log('DEBUG', msg);
const info  = (msg) => _log('INFO',  msg);
const warn  = (msg) => _log('WARN',  msg);
const error = (msg) => _log('ERROR', msg);

function summarizeStroke(stroke) {
  const points = Array.isArray(stroke?.points) ? stroke.points.length : 0;
  const color  = stroke?.color ?? 'n/a';
  const width  = stroke?.width ?? 'n/a';
  return `stroke(points=${points}, color=${color}, width=${width})`;
}

function logCommitEvent(entry, boardId, source) {
  if (!entry) return;
  info(
    `COMMIT board=${boardId} index=${entry.index}, term=${entry.term},` +
    ` ${summarizeStroke(entry.stroke)}, source=${source}`
  );
}

// ── Global RAFT state ─────────────────────────────────────────────────────────
let state         = 'Follower';  // 'Follower' | 'Candidate' | 'Leader'
let currentTerm   = 0;
let votedFor      = null;        // replicaId string or null
let currentLeader = null;

let electionTimer      = null;
let heartbeatTimer     = null;
let electionInProgress = false;

/**
 * [FIX-REJOIN-1] Timestamp of last valid heartbeat/AppendEntries received from
 * a legitimate leader. Used to implement "leader stickiness": a node that
 * recently heard from a leader will refuse to vote for a newcomer, preventing
 * a restarted node from disrupting an active cluster.
 */
let lastLeaderContact = 0;  // epoch ms, 0 = never

// ── Per-board state ───────────────────────────────────────────────────────────
/**
 * boardLogs: Map<boardId, StrokeLog>
 * Each board has its own independent append-only log.
 * Created lazily on first access via _getLog(boardId).
 */
const boardLogs        = new Map();  // boardId → StrokeLog instance
const boardCommitIndex = new Map();  // boardId → commitIndex (number, default 0)

const DEFAULT_BOARD = 'board-public';

/**
 * Lazily retrieve (or create) the StrokeLog for a given boardId.
 */
function _getLog(boardId) {
  const id = boardId || DEFAULT_BOARD;
  if (!boardLogs.has(id)) {
    boardLogs.set(id, new StrokeLog());
    boardCommitIndex.set(id, 0);
  }
  return boardLogs.get(id);
}

function _getCommitIndex(boardId) {
  const id = boardId || DEFAULT_BOARD;
  return boardCommitIndex.get(id) ?? 0;
}

function _setCommitIndex(boardId, index) {
  const id = boardId || DEFAULT_BOARD;
  boardCommitIndex.set(id, index);
}

/**
 * Board-scoped lastIndex (uses global log if backwards-compat needed for election RPCs).
 * For election log-up-to-date checks we need a global view — use the max across all boards.
 */
function _globalLastIndex() {
  if (boardLogs.size === 0) return 0;
  let max = 0;
  for (const log of boardLogs.values()) {
    if (log.lastIndex() > max) max = log.lastIndex();
  }
  return max;
}

function _globalLastTerm() {
  if (boardLogs.size === 0) return 0;
  let latestTerm = 0;
  let latestIndex = 0;
  for (const log of boardLogs.values()) {
    const li = log.lastIndex();
    const lt = log.lastTerm();
    if (li > latestIndex || (li === latestIndex && lt > latestTerm)) {
      latestIndex = li;
      latestTerm  = lt;
    }
  }
  return latestTerm;
}

// ── Cluster constants ─────────────────────────────────────────────────────────
const CLUSTER_SIZE = config.PEERS.length + 1;
const MAJORITY     = Math.floor(CLUSTER_SIZE / 2) + 1; // 2 of 3

// ── Timer helpers ─────────────────────────────────────────────────────────────

function randomElectionTimeout() {
  return Math.floor(
    Math.random() * (config.ELECTION_TIMEOUT_MAX_MS - config.ELECTION_TIMEOUT_MIN_MS)
    + config.ELECTION_TIMEOUT_MIN_MS
  );
}

function resetElectionTimer() {
  clearTimeout(electionTimer);
  electionTimer = setTimeout(startElection, randomElectionTimeout());
}

/**
 * [FIX-REJOIN-1] Record the current time as the last moment a valid leader
 * message was received.  Called from handleHeartbeat and handleAppendEntries.
 */
function _touchLeaderContact() {
  lastLeaderContact = Date.now();
}

/**
 * [FIX-REJOIN-1] Returns true if we heard from a live leader within the
 * minimum election timeout window.  During this window we should not grant
 * votes to new candidates — the cluster already has a healthy leader.
 */
function _recentLeaderContact() {
  return (Date.now() - lastLeaderContact) < config.ELECTION_TIMEOUT_MIN_MS;
}

function clearElectionTimer() {
  clearTimeout(electionTimer);
  electionTimer = null;
}

function clearHeartbeatTimer() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// ── State Transitions ─────────────────────────────────────────────────────────

function becomeFollower(term) {
  const prev = state;
  state       = 'Follower';
  currentTerm = term;
  votedFor    = null;
  clearHeartbeatTimer();
  resetElectionTimer();
  info(
    `→ FOLLOWER  (term ${term})` +
    (prev === 'Leader' ? ' [stepped down from Leader]' : '')
  );
}

function becomeCandidate() {
  state       = 'Candidate';
  currentTerm += 1;
  votedFor    = config.REPLICA_ID;
  clearHeartbeatTimer();
  info(`→ CANDIDATE (term ${currentTerm})`);
}

function becomeLeader() {
  state         = 'Leader';
  currentLeader = config.REPLICA_ID;
  clearElectionTimer();
  sendHeartbeats();
  heartbeatTimer = setInterval(sendHeartbeats, config.HEARTBEAT_INTERVAL_MS);
  info(
    `→ LEADER    (term ${currentTerm})` +
    ` | cluster: ${CLUSTER_SIZE} nodes, majority: ${MAJORITY}`
  );
}

// ── Leader Election ───────────────────────────────────────────────────────────

async function startElection() {
  if (state === 'Leader') return;
  if (electionInProgress) return;

  electionInProgress = true;
  becomeCandidate();

  let votes       = 1;
  let steppedDown = false;

  // Use global last index/term for election log-up-to-date check
  const reqLastLogIndex = _globalLastIndex();
  const reqLastLogTerm  = _globalLastTerm();

  info(`Requesting votes from ${config.PEERS.length} peer(s)...`);

  const voteRequests = config.PEERS.map(async (peer) => {
    debug(
      `RequestVote → ${peer} (term=${currentTerm}, lastLogIndex=${reqLastLogIndex},` +
      ` lastLogTerm=${reqLastLogTerm})`
    );
    try {
      const res = await axios.post(`${peer}/request-vote`, {
        term:         currentTerm,
        candidateId:  config.REPLICA_ID,
        lastLogIndex: reqLastLogIndex,
        lastLogTerm:  reqLastLogTerm,
      }, { timeout: config.RPC_TIMEOUT_MS });

      if (res.data.term > currentTerm) {
        info(`Higher term (${res.data.term}) from ${peer} — stepping down`);
        becomeFollower(res.data.term);
        steppedDown = true;
        return;
      }

      if (res.data.voteGranted) {
        votes += 1;
        info(`Vote granted by ${peer} (total: ${votes})`);
      } else {
        info(`Vote denied  by ${peer}`);
      }
    } catch {
      warn(`RequestVote → ${peer} unreachable / timed out`);
    }
  });

  await Promise.allSettled(voteRequests);
  electionInProgress = false;

  if (steppedDown || state !== 'Candidate') return;

  if (votes >= MAJORITY) {
    becomeLeader();
  } else {
    warn(
      `Election failed — votes: ${votes}/${MAJORITY} needed. Retrying after next timeout.`
    );
    becomeFollower(currentTerm);
  }
}

// ── Heartbeat Sender (Leader → Followers) ─────────────────────────────────────

/**
 * Broadcasts heartbeats to all peers IN PARALLEL.
 * [BUG-2 FIX] Was sequential for-of + await; now parallel Promise.allSettled.
 *
 * Heartbeat carries the global commitIndex summary — followers use this
 * to advance their own commitIndex per board after board-specific AppendEntries.
 * We send the per-board commitIndex map so followers stay in sync.
 */
async function sendHeartbeats() {
  if (state !== 'Leader') return;

  // Build a compact per-board commitIndex snapshot for the heartbeat
  const boardCommits = {};
  for (const [bid, ci] of boardCommitIndex.entries()) {
    if (ci > 0) boardCommits[bid] = ci;
  }

  // Global commitIndex for backward-compat (max across boards)
  const globalCommit = Math.max(0, ...[...boardCommitIndex.values()]);

  debug(
    `Heartbeat tick (term=${currentTerm}, globalCommit=${globalCommit}, peers=${config.PEERS.length})`
  );

  const laggingPeers = [];

  await Promise.allSettled(
    config.PEERS.map(async (peer) => {
      debug(`Heartbeat → ${peer} (term=${currentTerm})`);
      try {
        const res = await axios.post(`${peer}/heartbeat`, {
          term:         currentTerm,
          leaderId:     config.REPLICA_ID,
          leaderCommit: globalCommit,
          boardCommits,           // NEW: per-board commit indices
        }, { timeout: config.RPC_TIMEOUT_MS });

        debug(
          `Heartbeat ACK ← ${peer}` +
          ` (term=${res.data.term}, success=${res.data.success}, logLength=${res.data.logLength ?? 'n/a'})`
        );

        if (res.data.term > currentTerm) {
          info(`Higher term (${res.data.term}) in heartbeat reply from ${peer} — stepping down`);
          becomeFollower(res.data.term);
          return;
        }

        if (
          res.data.success &&
          typeof res.data.logLength === 'number' &&
          res.data.logLength < globalCommit
        ) {
          laggingPeers.push(`${peer}(logLen=${res.data.logLength})`);
          triggerSyncLog(peer, res.data.logLength, res.data.boardLogLengths || {}).catch(() => {});
        }
      } catch {
        debug(`Heartbeat timeout/unreachable ← ${peer}`);
      }
    })
  );

  if (laggingPeers.length > 0) {
    info(
      `Lagging peer(s) detected (globalCommit=${globalCommit}): ${laggingPeers.join(', ')} — /sync-log triggered`
    );
  }
}

// ── RPC Handlers ─────────────────────────────────────────────────────────────

/**
 * POST /request-vote
 */
function handleRequestVote(body) {
  const { term, candidateId, lastLogIndex, lastLogTerm } = body;

  // [FIX-REJOIN-1] Leader stickiness: if we recently heard from a live leader,
  // refuse to vote for anyone else — even if their term is higher.  This
  // prevents a restarted node (which always starts at term 0 and immediately
  // increments) from disrupting an active cluster by forcing incumbent nodes
  // to call becomeFollower() and reset their votedFor.
  //
  // Exception: if the candidate's term is already known to us (term <= currentTerm
  // with a stale votedFor) we still apply the normal grant rules, but we never
  // step down to follow a stale-term candidate.
  if (term > currentTerm && _recentLeaderContact()) {
    warn(
      `Ignoring RequestVote from ${candidateId} (term ${term} > ${currentTerm})` +
      ` — heard from leader ${currentLeader} within minimum election timeout; ` +
      `cluster is healthy, refusing to disrupt leader.`
    );
    // Reply with our current term so the requester learns the cluster is live;
    // voteGranted=false keeps them from winning an unnecessary election.
    return { term: currentTerm, voteGranted: false };
  }

  if (term > currentTerm) {
    becomeFollower(term);
  }

  const myLastIndex = _globalLastIndex();
  const myLastTerm  = _globalLastTerm();

  const logUpToDate =
    lastLogTerm > myLastTerm ||
    (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);

  const voteGranted =
    term >= currentTerm &&
    (votedFor === null || votedFor === candidateId) &&
    logUpToDate;

  if (voteGranted) {
    votedFor = candidateId;
    resetElectionTimer();
    info(`✓ Voted for ${candidateId} in term ${term}`);
  } else {
    info(
      `✗ Denied vote for ${candidateId} in term ${term}` +
      ` (votedFor=${votedFor}, logUpToDate=${logUpToDate})` +
      ` [recentLeaderContact=${_recentLeaderContact()}]`
    );
  }

  return { term: currentTerm, voteGranted };
}

/**
 * POST /heartbeat
 * Advances per-board commitIndex from the boardCommits map in the heartbeat.
 */
function handleHeartbeat(body) {
  const { term, leaderId, leaderCommit, boardCommits = {} } = body;

  debug(
    `Heartbeat received ← ${leaderId}` +
    ` (term=${term}, leaderCommit=${leaderCommit}, currentTerm=${currentTerm})`
  );

  if (term < currentTerm) {
    debug(`Heartbeat rejected as stale (incomingTerm=${term}, currentTerm=${currentTerm})`);
    return { term: currentTerm, success: false };
  }

  if (term > currentTerm) {
    becomeFollower(term);
  } else if (state === 'Candidate') {
    becomeFollower(term);
  }

  currentLeader = leaderId;
  _touchLeaderContact(); // [FIX-REJOIN-1] record live-leader contact time
  resetElectionTimer();

  // Advance per-board commitIndex based on leader's knowledge
  for (const [bid, leaderCI] of Object.entries(boardCommits)) {
    const myCI = _getCommitIndex(bid);
    if (leaderCI > myCI) {
      const log       = _getLog(bid);
      const newCommit = Math.min(leaderCI, log.lastIndex());
      for (let i = myCI + 1; i <= newCommit; i++) {
        log.commit(i);
        logCommitEvent(log.getEntry(i), bid, `heartbeat:${leaderId}`);
      }
      _setCommitIndex(bid, newCommit);
      info(`board=${bid} commitIndex → ${newCommit} (via heartbeat from ${leaderId})`);
    }
  }

  // Compute total log length across all boards for leader's lagging detection
  let totalLogLength = 0;
  const boardLogLengths = {};
  for (const [bid, log] of boardLogs.entries()) {
    boardLogLengths[bid] = log.length;
    totalLogLength += log.length;
  }

  return { term: currentTerm, success: true, logLength: totalLogLength, boardLogLengths };
}

/**
 * POST /append-entries
 * Routes log operations to the correct board's StrokeLog.
 */
function handleAppendEntries(body) {
  const { term, leaderId, prevLogIndex, prevLogTerm, entry, leaderCommit, boardId } = body;
  const bid = boardId || DEFAULT_BOARD;
  const log = _getLog(bid);

  // 1. Reject stale RPCs
  if (term < currentTerm) {
    return { term: currentTerm, success: false };
  }

  // 2. Update state
  if (term > currentTerm) {
    becomeFollower(term);
  } else if (state === 'Candidate') {
    becomeFollower(term);
  }

  currentLeader = leaderId;
  _touchLeaderContact(); // [FIX-REJOIN-1] record live-leader contact time
  resetElectionTimer();

  // 3. Log consistency check
  if (prevLogIndex > 0) {
    const prevEntry = log.getEntry(prevLogIndex);

    if (!prevEntry) {
      warn(
        `board=${bid} Missing prevLogIndex=${prevLogIndex}` +
        ` — need sync (our logLength=${log.length})`
      );
      return { term: currentTerm, success: false, logLength: log.length, boardId: bid };
    }

    if (prevEntry.term !== prevLogTerm) {
      warn(
        `board=${bid} Log conflict at index=${prevLogIndex}:` +
        ` expected term ${prevLogTerm}, got ${prevEntry.term}`
      );
      return { term: currentTerm, success: false, logLength: log.length, boardId: bid };
    }
  }

  // 4 & 5. Append entry (with conflict handling)
  if (entry) {
    const existing = log.getEntry(entry.index);
    if (existing) {
      if (existing.term !== entry.term) {
        log.truncateFrom(entry.index);
        log.append(entry.term, entry.stroke);
        warn(`board=${bid} Conflict at index=${entry.index} — truncated and re-appended`);
      }
      // else: identical entry already present — idempotent no-op
    } else {
      log.append(entry.term, entry.stroke);
      info(`board=${bid} Appended entry index=${entry.index}, term=${entry.term}`);
    }
  }

  // 6. Advance commitIndex for this board
  const myCI = _getCommitIndex(bid);
  if (leaderCommit > myCI) {
    const newCommit = Math.min(leaderCommit, log.lastIndex());
    for (let i = myCI + 1; i <= newCommit; i++) {
      log.commit(i);
      logCommitEvent(log.getEntry(i), bid, `append-entries:${leaderId}`);
    }
    _setCommitIndex(bid, newCommit);
    info(`board=${bid} commitIndex → ${newCommit} (via AppendEntries from ${leaderId})`);
  }

  return { term: currentTerm, success: true };
}

/**
 * POST /sync-log
 * Bulk catch-up: leader sends all committed entries the follower is missing.
 * Routes by boardId.
 */
function handleSyncLog(body) {
  const { term, leaderId, entries, leaderCommit, boardId } = body;
  const bid = boardId || DEFAULT_BOARD;
  const log = _getLog(bid);

  if (term < currentTerm) {
    return { success: false, term: currentTerm };
  }

  if (term > currentTerm) {
    becomeFollower(term);
  }

  currentLeader = leaderId;
  resetElectionTimer();

  info(`board=${bid} /sync-log: received ${entries.length} entries from ${leaderId}`);

  for (const e of entries) {
    const existing = log.getEntry(e.index);
    if (!existing) {
      log.append(e.term, e.stroke);
      info(`  board=${bid} sync-append  index=${e.index}, term=${e.term}`);
    } else if (existing.term !== e.term) {
      log.truncateFrom(e.index);
      log.append(e.term, e.stroke);
      warn(`  board=${bid} sync-replace index=${e.index} (term mismatch)`);
    }
  }

  const myCI = _getCommitIndex(bid);
  if (leaderCommit > myCI) {
    const newCommit = Math.min(leaderCommit, log.lastIndex());
    for (let i = myCI + 1; i <= newCommit; i++) {
      log.commit(i);
      logCommitEvent(log.getEntry(i), bid, `sync-log:${leaderId}`);
    }
    _setCommitIndex(bid, newCommit);
    info(`board=${bid} Post-sync commitIndex → ${newCommit}`);
  }

  return { success: true, logLength: log.length };
}

// ── Client Stroke Pipeline (Leader only) ──────────────────────────────────────

/**
 * POST /client-stroke
 * Full replication pipeline with boardId routing.
 *  1. Reject if not Leader
 *  2. Append stroke to boardLogs[boardId]
 *  3. Send AppendEntries (with boardId) to all peers in parallel
 *  4. Commit if majority ACKed
 *  5. Notify Gateway with boardId
 */
async function handleClientStroke(stroke, boardId) {
  if (state !== 'Leader') {
    return { success: false, error: 'not leader', leader: currentLeader };
  }

  const bid = boardId || DEFAULT_BOARD;
  const log = _getLog(bid);

  // Step 1: Append to board-specific local log
  const entry        = log.append(currentTerm, stroke);
  const prevLogIndex = entry.index - 1;
  const prevLogTerm  = prevLogIndex > 0 ? (log.getEntry(prevLogIndex)?.term ?? 0) : 0;

  info(`board=${bid} Stroke received → appended index=${entry.index}, term=${currentTerm}`);

  // Step 2: Replicate to all peers with boardId
  let acks        = 1;
  let steppedDown = false;

  await Promise.allSettled(
    config.PEERS.map(async (peer) => {
      try {
        const res = await axios.post(`${peer}/append-entries`, {
          term:         currentTerm,
          leaderId:     config.REPLICA_ID,
          prevLogIndex,
          prevLogTerm,
          boardId:      bid,          // NEW: route to correct board log on follower
          entry: {
            index:  entry.index,
            term:   entry.term,
            stroke: entry.stroke,
          },
          leaderCommit: entry.index,  // [BUG-1 FIX] post-commit — followers commit immediately
        }, { timeout: config.RPC_TIMEOUT_MS });

        if (res.data.term > currentTerm) {
          info(`Higher term (${res.data.term}) from ${peer} during replication — stepping down`);
          becomeFollower(res.data.term);
          steppedDown = true;
          return;
        }

        if (res.data.success) {
          acks += 1;
          info(`ACK from ${peer} for board=${bid} index=${entry.index} (acks: ${acks})`);
        } else {
          const followerLen = res.data.logLength ?? 0;
          warn(
            `${peer} rejected AppendEntries for board=${bid}` +
            ` (logLength=${followerLen}) — triggering /sync-log`
          );
          triggerSyncLog(peer, followerLen, {}, bid).catch(() => {});
        }
      } catch {
        warn(`AppendEntries → ${peer} unreachable / timed out (board=${bid})`);
      }
    })
  );

  if (steppedDown || state !== 'Leader') {
    return { success: false, error: 'leadership lost during replication' };
  }

  // Step 3: Commit on majority
  if (acks >= MAJORITY) {
    _setCommitIndex(bid, entry.index);
    log.commit(entry.index);
    logCommitEvent(entry, bid, 'leader-local-quorum');
    info(`✓ board=${bid} Committed index=${entry.index} (acks: ${acks}/${CLUSTER_SIZE})`);

    // Step 4: Notify Gateway with boardId
    await notifyGateway(entry, bid);

    return { success: true, index: entry.index };
  }

  warn(
    `✗ board=${bid} No quorum for index=${entry.index}` +
    ` — acks: ${acks}/${MAJORITY} needed`
  );
  return { success: false, error: 'no quorum', acks };
}

// ── Sync-Log Trigger (Leader → Lagging Follower) ─────────────────────────────

/**
 * Leader sends missing entries from a specific board (or all boards) to a peer.
 *
 * @param {string} peer           - Peer URL
 * @param {number} followerLogLen - Follower's reported global log length
 * @param {object} boardLogLens   - Per-board log lengths reported by follower
 * @param {string} [targetBoardId] - If set, only sync this board
 */
async function triggerSyncLog(peer, followerLogLen, boardLogLens = {}, targetBoardId = null) {
  const boardsToSync = targetBoardId
    ? [[targetBoardId, _getLog(targetBoardId)]]
    : [...boardLogs.entries()];

  for (const [bid, log] of boardsToSync) {
    const followerBoardLen = boardLogLens[bid] ?? 0;
    const missingEntries   = log.getFrom(followerBoardLen + 1);
    if (missingEntries.length === 0) continue;

    info(`board=${bid} Sending ${missingEntries.length} missing entries to ${peer} via /sync-log`);

    try {
      await axios.post(`${peer}/sync-log`, {
        term:         currentTerm,
        leaderId:     config.REPLICA_ID,
        boardId:      bid,
        entries:      missingEntries.map(e => ({ index: e.index, term: e.term, stroke: e.stroke })),
        leaderCommit: _getCommitIndex(bid),
      }, { timeout: config.RPC_TIMEOUT_MS * 5 });
    } catch (err) {
      warn(`/sync-log to ${peer} for board=${bid} failed: ${err.message}`);
    }
  }
}

// ── Gateway Notification ──────────────────────────────────────────────────────

/**
 * After committing an entry, POST /broadcast to Gateway with boardId.
 * Gateway uses boardId to push stroke only to clients on the same board.
 */
async function notifyGateway(entry, boardId) {
  const bid = boardId || DEFAULT_BOARD;
  try {
    await axios.post(`${config.GATEWAY_URL}/broadcast`, {
      boardId: bid,
      stroke: {
        index: entry.index,
        ...entry.stroke,
      },
    }, { timeout: 1000 });
    info(`Gateway notified — board=${bid} broadcast index=${entry.index}`);
  } catch (err) {
    warn(`Gateway notify failed (board=${bid}, index=${entry.index}): ${err.message}`);
  }
}

// ── Public query: committed log for a given board ────────────────────────────

/**
 * Returns committed strokes for a specific board.
 * Called by server.js GET /committed-log?boardId=X for Gateway full-sync.
 */
function getCommittedLog(boardId) {
  const bid = boardId || DEFAULT_BOARD;
  const log = _getLog(bid);
  return log.getCommitted().map(e => ({ index: e.index, ...e.stroke }));
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function start() {
  info(`── Mini-RAFT node starting (multi-tenant) ───────`);
  info(`   Peers       : ${config.PEERS.join(', ') || '(none)'}`);
  info(`   Cluster size: ${CLUSTER_SIZE}`);
  info(`   Majority    : ${MAJORITY}`);
  info(`   Election TO : ${config.ELECTION_TIMEOUT_MIN_MS}–${config.ELECTION_TIMEOUT_MAX_MS} ms`);
  info(`   Heartbeat   : every ${config.HEARTBEAT_INTERVAL_MS} ms`);
  info(`──────────────────────────────────────────────────`);

  // [FIX-REJOIN-2] Use a startup delay that is guaranteed to be LONGER than
  // the heartbeat interval (150 ms) so an already-running leader has time to
  // send at least one heartbeat before the election timer fires for the first
  // time.  This ensures a restarted node learns the current term via the
  // heartbeat and becomes a follower instead of disrupting the cluster with a
  // spurious election.
  //
  // We stagger the per-replica delay so that if multiple nodes restart
  // simultaneously (e.g. full cluster restart) they don't all hold elections
  // at the same millisecond.
  //
  //   replica1 → 200 ms   (1-1)*200 = 0  + 200 base
  //   replica2 → 400 ms   (2-1)*200 = 200 + 200 base
  //   replica3 → 600 ms   (3-1)*200 = 400 + 200 base
  //
  // The base 200 ms >> heartbeat interval (150 ms), so a live leader is heard
  // before the election timer ever fires.
  const idDigit    = parseInt(config.REPLICA_ID.replace(/\D/g, ''), 10) || 1;
  const startDelay = 200 + (idDigit - 1) * 200;  // was: (idDigit-1)*50
  info(`Startup delay: ${startDelay} ms (heartbeat=${config.HEARTBEAT_INTERVAL_MS} ms — will receive heartbeat before first election)`);
  setTimeout(() => becomeFollower(0), startDelay);
}

/**
 * Returns the current observable RAFT state.
 * Shape: { id, state, term, leader, logLength, commitIndex, boards }
 */
function getStatus() {
  const boards = {};
  for (const [bid, log] of boardLogs.entries()) {
    boards[bid] = {
      logLength:   log.length,
      commitIndex: _getCommitIndex(bid),
    };
  }
  return {
    id:          config.REPLICA_ID,
    state,
    term:        currentTerm,
    leader:      currentLeader,
    logLength:   _globalLastIndex(),
    commitIndex: Math.max(0, ...[...boardCommitIndex.values()]),
    boards,
  };
}

module.exports = {
  start,
  getStatus,
  handleRequestVote,
  handleHeartbeat,
  handleAppendEntries,
  handleSyncLog,
  handleClientStroke,
  getCommittedLog,
  // ── Test helper: access the default board's StrokeLog (for unit tests only) ──
  _getDefaultLog: () => _getLog(DEFAULT_BOARD),
};
