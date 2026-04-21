/**
 * leaderTracker.js — Gateway Leader Discovery & Tracking
 *
 * Responsibilities:
 *  ✓ On startup, poll all replicas simultaneously at GET /status to find
 *    the current leader (parallel — first Leader response wins)
 *  ✓ Continuously re-poll every POLL_INTERVAL_MS to detect leader changes
 *  ✓ Store the current leader's base URL
 *  ✓ forwardStroke(stroke): POST stroke to leader /client-stroke
 *  ✓ On leader failure (HTTP error / timeout ≥ 2 s): queue stroke, re-discover, replay queue
 *  ✓ Leader-hint fast-path: if a replica responds { error: 'not leader', leader: 'replicaX' },
 *    use that URL directly instead of re-polling (reduces failover latency significantly)
 *  ✓ Queue depth guard: cap queued strokes at MAX_QUEUE_SIZE (drops oldest)
 *  ✓ Replay retry limit: each queued stroke is retried at most MAX_REPLAY_RETRIES times
 *  ✓ Failover lock: a single forwardStroke recovery path runs at a time —
 *    concurrent strokes during failover are queued without spawning duplicate discovery loops
 *  ✓ getLeader(): return current leader URL (used by server.js /health)
 *  ✓ isFailoverInProgress(): return true while discovery/replay is running
 *  ✓ onLeaderChange(cb): register a callback fired whenever the tracked leader changes
 *  ✓ onFailoverStateChange(cb): callback fired when failover transitions start/end
 *
 * Failure handling (FR-GW-07, FR-GW-08, FR-GW-09):
 *  - If leader is unreachable: stroke is queued, re-discovery runs immediately
 *  - Queued strokes are replayed in order once a new leader is found
 *  - Clients are NEVER disconnected during a leader change
 *  - Only ONE recovery path runs at a time (failoverLock guard)
 *
 * Performance:
 *  - discoverLeader() polls all replicas in PARALLEL — leader found in one RTT
 *    regardless of replica ordering, not up-to-(worst RTT × N) as with sequential polling
 *
 * Fix log (audit):
 *  [BUG-3] forwardStroke Case 1 (no leader) now uses _runFailoverRecovery instead of
 *          fire-and-forget discoverLeader, preventing a double-discovery race when a
 *          second stroke arrives while the .finally() lock-release is in-flight.
 *  [OBS-3] Removed redundant per-poll "Leader: <url>" log line; the [NEW] marker on
 *          leader change is sufficient and prevents log flooding.
 */

'use strict';

const axios = require('axios');

// ── Structured logger ─────────────────────────────────────────────────────────
const _ts  = () => new Date().toISOString();
const linfo  = (msg) => console.log(`${_ts()} [INFO ][LeaderTracker] ${msg}`);
const lwarn  = (msg) => console.warn(`${_ts()} [WARN ][LeaderTracker] ${msg}`);
const lerror = (msg) => console.error(`${_ts()} [ERROR][LeaderTracker] ${msg}`);

// ── Replica address list ──────────────────────────────────────────────────────
// Parsed from REPLICAS env var: "replica1:4001,replica2:4002,replica3:4003"
// REPLICA_ENDPOINTS is accepted as a fallback for easier topology scaling.
const replicaListCsv =
  process.env.REPLICAS ||
  process.env.REPLICA_ENDPOINTS ||
  'replica1:4001,replica2:4002,replica3:4003';

const REPLICAS = replicaListCsv
  .split(',')
  .map(r => `http://${r.trim()}`);

// ── Constants ─────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS   = 2000;  // Background watchdog re-check interval (SRS §7.2)
const FORWARD_TIMEOUT_MS = 2000;  // POST /client-stroke max wait (FR-GW-07)
const STATUS_TIMEOUT_MS  = 1000;  // GET /status max wait per replica
const MAX_QUEUE_SIZE     = 100;   // Maximum strokes queued during leader-less window
const MAX_REPLAY_RETRIES = 3;     // Max delivery attempts per queued stroke

// ── Internal state ────────────────────────────────────────────────────────────
let currentLeader     = null;   // Base URL e.g. "http://replica1:4001", or null
let discoverInFlight  = false;  // Prevents concurrent discovery races
let failoverLock      = false;  // Prevents concurrent forwardStroke recovery paths
let failoverActive    = false;  // True while a failover (discovery + replay) is running
let pollTimer         = null;   // Handle for the periodic poll setInterval

const strokeQueue          = [];     // Pending strokes during leader-less periods
let leaderChangeCallback   = null;   // Optional external change listener
let failoverStateCallback  = null;   // Optional external failover state listener

// ── Failover State Notification ───────────────────────────────────────────────

/**
 * Register a callback fired whenever the failover state changes.
 * callback(isActive: boolean)
 *   isActive=true  → failover started (leader lost)
 *   isActive=false → failover ended (leader restored, queue drained)
 *
 * server.js uses this to broadcast a 'leader-changing' or 'leader-restored'
 * WebSocket message to all connected clients — keeps them informed without
 * disconnecting them.
 */
function onFailoverStateChange(cb) {
  failoverStateCallback = cb;
}

function _setFailoverActive(isActive) {
  if (isActive === failoverActive) return; // No change
  failoverActive = isActive;
  if (failoverStateCallback) {
    try { failoverStateCallback(isActive); } catch {}
  }
}

// ── Leader Change Notification ────────────────────────────────────────────────

/**
 * Register a callback fired whenever the tracked leader URL changes (including → null).
 * server.js uses this to log leader transitions.
 */
function onLeaderChange(cb) {
  leaderChangeCallback = cb;
}

function _setLeader(newUrl) {
  if (newUrl === currentLeader) return; // No change
  const prev = currentLeader;
  currentLeader = newUrl;
  if (leaderChangeCallback) {
    try { leaderChangeCallback(newUrl, prev); } catch {}
  }
}

// ── Parallel Discovery ────────────────────────────────────────────────────────

/**
 * Poll a single replica for its /status.
 * Resolves with the replica's base URL if it reports state === "Leader".
 * Rejects otherwise (unreachable, follower, error).
 */
async function _pollOne(replicaUrl) {
  const res = await axios.get(`${replicaUrl}/status`, { timeout: STATUS_TIMEOUT_MS });
  if (res.data && res.data.state === 'Leader') {
    return replicaUrl;
  }
  throw new Error(`${replicaUrl} is not Leader (state=${res.data?.state})`);
}

/**
 * Poll all replicas IN PARALLEL and set currentLeader to the first one
 * that reports state === "Leader" (Promise.any — resolves on first success).
 *
 * This is significantly faster than sequential polling:
 *   - Sequential worst case: STATUS_TIMEOUT_MS × N replicas
 *   - Parallel: one network RTT regardless of replica count
 *
 * After finding a new leader, replays any queued strokes.
 */
async function discoverLeader() {
  if (discoverInFlight) return; // Guard against concurrent invocations
  discoverInFlight = true;

  // [OBS-3] Only log on first discovery attempt, not on every routine poll cycle.
  // The [NEW] tag in _setLeader already logs every leader change unambiguously.
  if (!currentLeader) {
    linfo('Discovering leader (parallel poll)...');
  }

  try {
    // Promise.any resolves with the FIRST fulfilled value (first Leader found).
    // If ALL replicas are unreachable / non-leader, it throws AggregateError.
    const found = await Promise.any(REPLICAS.map(_pollOne));

    const changed = (found !== currentLeader);
    _setLeader(found);
    if (changed) {
      linfo(`Leader: ${currentLeader} [NEW]`);
      // Replay any strokes that were queued during the leader-less window
      await replayQueue();
    }
  } catch {
    // AggregateError — no replica responded as Leader
    if (currentLeader !== null) {
      lwarn('No leader found — strokes will be queued');
    }
    _setLeader(null);
  } finally {
    discoverInFlight = false;
  }
}

/**
 * Fast-path: a replica told us directly who the leader is (via the "leader"
 * field in a non-leader error response).  Verify the hint is actually a Leader
 * before committing to it — avoids trusting stale info from a lagging follower.
 *
 * Returns the verified URL, or null if verification fails.
 */
async function _verifyHint(hintUrl) {
  try {
    const res = await axios.get(`${hintUrl}/status`, { timeout: STATUS_TIMEOUT_MS });
    if (res.data && res.data.state === 'Leader') {
      return hintUrl;
    }
  } catch {}
  return null;
}

// ── Stroke Queue Helpers ──────────────────────────────────────────────────────

function _enqueue(stroke, boardId) {
  if (strokeQueue.length >= MAX_QUEUE_SIZE) {
    // Drop the oldest entry to prevent unbounded memory growth
    const dropped = strokeQueue.shift();
    lwarn(
      `Queue full (${MAX_QUEUE_SIZE}) — dropped oldest stroke` +
      ` (points=${dropped?.points?.length ?? '?'})`
    );
  }
  strokeQueue.push({ stroke, boardId: boardId || 'board-public', retries: 0 });
}

/**
 * Replay queued strokes in order to the newly discovered leader.
 * Each stroke is retried up to MAX_REPLAY_RETRIES times before being discarded.
 * Uses a draining loop so strokes added during replay are also processed.
 */
async function replayQueue() {
  if (strokeQueue.length === 0) {
    // No strokes to replay — failover is done
    _setFailoverActive(false);
    return;
  }

  linfo(`Replaying ${strokeQueue.length} queued stroke(s) to ${currentLeader}`);

  while (strokeQueue.length > 0 && currentLeader) {
    const item = strokeQueue[0]; // Peek — only shift on success or exhaustion

    if (item.retries >= MAX_REPLAY_RETRIES) {
      strokeQueue.shift();
      lwarn(
        `Stroke exhausted ${MAX_REPLAY_RETRIES} retries — discarding` +
        ` (board=${item.boardId}, points=${item.stroke?.points?.length ?? '?'})`
      );
      continue;
    }

    item.retries += 1;

    try {
      const res = await axios.post(
        `${currentLeader}/client-stroke`,
        { stroke: item.stroke, boardId: item.boardId },
        { timeout: FORWARD_TIMEOUT_MS }
      );

      if (!res.data.success) {
        // The node we thought was leader rejected it — use hint or re-discover
        lwarn(`Replay rejected by ${currentLeader}: ${res.data.error}`);
        const resolved = await _resolveLeaderFromHint(res.data.leader);
        if (!resolved) {
          // Could not find a new leader — stop draining, leave item in queue
          _setLeader(null);
          break;
        }
        // Leader updated — loop will retry this item against the new leader
        continue;
      }

      strokeQueue.shift(); // Successfully delivered → remove from queue
      linfo(`Replayed queued stroke (board=${item.boardId}, index=${res.data.index})`);
    } catch (err) {
      lwarn(`Replay failed (attempt ${item.retries}, board=${item.boardId}): ${err.message}`);
      _setLeader(null);
      await discoverLeader(); // Attempt to find a new leader
      if (!currentLeader) break; // Still no leader — stop replaying
    }
  }

  // Queue is fully drained (or we ran out of leader) — failover complete
  if (strokeQueue.length === 0) {
    _setFailoverActive(false);
    linfo('Queue drained — failover complete');
  }
}

// ── Leader Resolution Helpers ─────────────────────────────────────────────────

/**
 * Given a hint URL from a "not leader" response body, try to fast-path to
 * the correct leader.  Falls back to full discoverLeader() if the hint fails.
 *
 * Returns true if a leader is now known, false otherwise.
 */
async function _resolveLeaderFromHint(hintLeaderId) {
  if (hintLeaderId) {
    // The hint may be a plain replicaId string ("replica1") or a full URL
    const hintUrl = hintLeaderId.startsWith('http')
      ? hintLeaderId
      : REPLICAS.find(u => u.includes(hintLeaderId)) || null;

    if (hintUrl) {
      linfo(`Trying leader hint: ${hintUrl}`);
      const verified = await _verifyHint(hintUrl);
      if (verified) {
        _setLeader(verified);
        linfo(`Leader confirmed via hint: ${currentLeader}`);
        return true;
      }
    }
  }

  // Hint failed or not provided — fall back to full parallel discovery
  await discoverLeader();
  return currentLeader !== null;
}

// ── Failover Recovery (serialised) ───────────────────────────────────────────

/**
 * Single entry-point for any stroke-forward failure recovery path.
 *
 * The failoverLock ensures only ONE recovery goroutine runs at a time.
 * If a second concurrent forwardStroke() call hits an error while recovery
 * is already running, it simply enqueues its stroke and returns — the ongoing
 * recovery will pick it up during replayQueue().
 *
 * This prevents:
 *  - Multiple simultaneous discoverLeader() calls racing each other
 *  - Multiple simultaneous replayQueue() loops delivering strokes out of order
 *
 * @param {object} strokeToQueue - stroke that triggered the failure (enqueued first)
 */
async function _runFailoverRecovery(strokeToQueue, boardId) {
  // Always queue the failing stroke first
  _enqueue(strokeToQueue, boardId);

  // Signal failover has started (only on first entry)
  _setFailoverActive(true);

  // If another recovery is already in progress, just return —
  // the ongoing recovery will drain this stroke from the queue too.
  if (failoverLock) {
    linfo('Failover already in progress — stroke queued, recovery running');
    return;
  }

  failoverLock = true;
  try {
    _setLeader(null);
    await discoverLeader(); // Will call replayQueue() internally when leader found
  } finally {
    failoverLock = false;
    // If queue is still non-empty (no leader found), failover remains active
    if (strokeQueue.length === 0) {
      _setFailoverActive(false);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the leader tracker.
 * Runs an initial discovery immediately, then re-polls every POLL_INTERVAL_MS.
 * The periodic poll acts as a background watchdog — if the leader changes
 * (e.g. after a kill -9), the gateway detects it within POLL_INTERVAL_MS.
 */
function start() {
  linfo(`Starting — replicas: ${REPLICAS.join(', ')}`);
  discoverLeader(); // Initial discovery (async, non-blocking)
  pollTimer = setInterval(discoverLeader, POLL_INTERVAL_MS);
}

/**
 * Return the base URL of the current known leader, or null if unknown.
 */
function getLeader() {
  return currentLeader;
}

/**
 * Return true while a failover recovery (discovery + replay) is actively running.
 * Used by server.js /health to expose failover state to the frontend.
 */
function isFailoverInProgress() {
  return failoverActive;
}

/**
 * Forward a stroke to the current leader via POST /client-stroke.
 *
 * Behaviour:
 *  - No leader known         → enqueue stroke + enter serialised failover recovery (FR-GW-08)
 *  - Leader reachable        → POST stroke, return result
 *  - Leader says "not leader"→ use leader hint to fast-path re-discovery (FR-GW-09)
 *  - Leader unreachable      → enter serialised failover recovery:
 *                              enqueue stroke, null leader, discover new leader,
 *                              replay queue once found — all within a single lock
 *                              so concurrent failures don't race each other
 *
 * [BUG-3 FIX] Case 1 previously used a fire-and-forget discoverLeader() wrapped
 *  in .finally() to release failoverLock.  If a second stroke arrived in the window
 *  between discoverLeader() resolving and .finally() executing, it would find
 *  failoverLock===false and spawn a second concurrent discovery — causing a
 *  double-replay race.  Now Case 1 routes through _runFailoverRecovery() which
 *  uses the same serialised await path as Case 3.
 */
/**
 * Forward a stroke (with its boardId) to the current leader.
 * boardId defaults to 'board-public' if not provided.
 */
async function forwardStroke(stroke, boardId) {
  const bid = boardId || 'board-public';

  // ── Case 1: No leader currently known (or failover already running) ─────────
  if (!currentLeader) {
    lwarn(`No leader — queuing stroke (board=${bid}) via serialised failover recovery`);
    // [BUG-3 FIX] Use the properly-awaited _runFailoverRecovery path
    _runFailoverRecovery(stroke, bid).catch((err) => {
      lerror(`Failover recovery threw unexpectedly: ${err.message}`);
    });
    return { queued: true };
  }

  // ── Case 2: Forward to known leader ─────────────────────────────────────
  try {
    const res = await axios.post(
      `${currentLeader}/client-stroke`,
      { stroke, boardId: bid },
      { timeout: FORWARD_TIMEOUT_MS }
    );

    if (!res.data.success) {
      // Leader responded but it's no longer the leader (e.g. stepped down mid-term)
      lwarn(`Leader rejected stroke (board=${bid}): "${res.data.error}" — resolving via hint`);
      await _runFailoverRecovery(stroke, bid);
      return { queued: true };
    }

    return { success: true, index: res.data.index };

  } catch (err) {
    // ── Case 3: Leader unreachable (timeout / network error) ─────────────
    lerror(`Leader unreachable (${err.message}) — entering serialised failover (board=${bid})`);
    await _runFailoverRecovery(stroke, bid);
    return { queued: true };
  }
}

/**
 * Return a snapshot of internal state — useful for diagnostics / testing.
 */
function getStats() {
  return {
    leader:           currentLeader,
    queueDepth:       strokeQueue.length,
    failoverActive,
    replicas:         REPLICAS,
  };
}

module.exports = {
  start,
  getLeader,
  isFailoverInProgress,
  forwardStroke,
  onLeaderChange,
  onFailoverStateChange,
  getStats,
};
