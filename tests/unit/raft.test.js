'use strict';

/**
 * unit/raft.test.js — Unit tests for replica1/raft.js (Mini-RAFT State Machine)
 *
 * Strategy:
 *  - jest.resetModules() + jest.doMock() in beforeEach gives a FRESH module
 *    (and thus fresh module-level state) for every single test.
 *  - `axios` is completely mocked — no real HTTP calls ever leave the process.
 *  - `config` is replaced with a deterministic test fixture.
 *  - `log` is loaded fresh (real StrokeLog instance) via the module reset;
 *    we grab the same singleton raft.js is using by requiring it AFTER raft.
 *  - Fake timers prevent election / heartbeat timers from firing unexpectedly.
 *
 * Coverage:
 *  ✓ getStatus()           — initial state shape
 *  ✓ handleRequestVote()   — grant, deny, log-up-to-date check, term step-down
 *  ✓ handleHeartbeat()     — stale reject, step-down, commitIndex advance
 *  ✓ handleAppendEntries() — stale reject, prevLog mismatch, append, idempotent,
 *                            conflict truncate, commitIndex advance
 *  ✓ handleSyncLog()       — stale reject, bulk append, idempotent, conflict replace
 *  ✓ handleClientStroke()  — non-leader rejection with leader hint
 *  ✓ Leader path           — election via fake timers → handleClientStroke as Leader
 */

// ─── Test config fixture ─────────────────────────────────────────────────────

const TEST_CONFIG = {
  REPLICA_ID:               'replica1',
  PORT:                     4001,
  PEERS:                    ['http://replica2:4002', 'http://replica3:4003'],
  HEARTBEAT_INTERVAL_MS:    150,
  ELECTION_TIMEOUT_MIN_MS:  500,
  ELECTION_TIMEOUT_MAX_MS:  800,
  RPC_TIMEOUT_MS:           300,
  GATEWAY_URL:              'http://gateway:3000',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Stroke fixture */
const stroke = (color = 'red') => ({
  points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
  color,
  width: 3,
});

// ─── Per-test setup ───────────────────────────────────────────────────────────

let raft;
let log;
let axiosMock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();

  // Fresh axios mock object — re-created each test
  axiosMock = {
    post: jest.fn().mockResolvedValue({ data: { term: 0, voteGranted: true, success: true } }),
    get:  jest.fn().mockResolvedValue({ data: { state: 'Leader' } }),
  };

  // Register mocks BEFORE requiring any module (jest.doMock is NOT hoisted)
  jest.doMock('axios',                    () => axiosMock);
  jest.doMock('../../replica1/config',    () => TEST_CONFIG);

  // Load raft.js — internally manages per-board StrokeLog instances
  raft = require('../../replica1/raft');

  // Grab the default board's StrokeLog instance that raft.js is using
  // (log.js now exports the class, not a singleton, so we use raft's helper)
  log = raft._getDefaultLog();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// getStatus()
// ─────────────────────────────────────────────────────────────────────────────

describe('getStatus()', () => {
  test('returns the correct initial state shape', () => {
    const status = raft.getStatus();
    expect(status).toMatchObject({
      id:          'replica1',
      state:       'Follower',
      term:        0,
      leader:      null,
      logLength:   0,
      commitIndex: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleRequestVote()
// ─────────────────────────────────────────────────────────────────────────────

describe('handleRequestVote()', () => {
  test('grants vote when term matches, not yet voted, log is up-to-date', () => {
    const result = raft.handleRequestVote({
      term:         1,
      candidateId:  'replica2',
      lastLogIndex: 0,
      lastLogTerm:  0,
    });
    expect(result.voteGranted).toBe(true);
    expect(result.term).toBe(1);
  });

  test('updates currentTerm when candidate has higher term', () => {
    raft.handleRequestVote({
      term: 5, candidateId: 'replica2', lastLogIndex: 0, lastLogTerm: 0,
    });
    expect(raft.getStatus().term).toBe(5);
  });

  test('denies vote when already voted for a different candidate in same term', () => {
    // First vote granted to replica2
    raft.handleRequestVote({
      term: 1, candidateId: 'replica2', lastLogIndex: 0, lastLogTerm: 0,
    });
    // Second request from replica3 in same term
    const result = raft.handleRequestVote({
      term: 1, candidateId: 'replica3', lastLogIndex: 0, lastLogTerm: 0,
    });
    expect(result.voteGranted).toBe(false);
  });

  test('grants vote again if same candidate requests again (idempotent)', () => {
    raft.handleRequestVote({
      term: 1, candidateId: 'replica2', lastLogIndex: 0, lastLogTerm: 0,
    });
    const result = raft.handleRequestVote({
      term: 1, candidateId: 'replica2', lastLogIndex: 0, lastLogTerm: 0,
    });
    expect(result.voteGranted).toBe(true);
  });

  test('denies vote when candidate term is LESS than currentTerm', () => {
    // First advance our term to 3
    raft.handleRequestVote({
      term: 3, candidateId: 'replica2', lastLogIndex: 0, lastLogTerm: 0,
    });
    // Now a stale candidate with term 2 asks for vote
    const result = raft.handleRequestVote({
      term: 2, candidateId: 'replica3', lastLogIndex: 0, lastLogTerm: 0,
    });
    expect(result.voteGranted).toBe(false);
  });

  test('denies vote when our log is more up-to-date (candidate lastLogTerm < ours)', () => {
    // Add an entry with term 2 to our log
    log.append(2, stroke());
    // Candidate only has term 1 entries
    const result = raft.handleRequestVote({
      term: 2, candidateId: 'replica2', lastLogIndex: 1, lastLogTerm: 1,
    });
    expect(result.voteGranted).toBe(false);
  });

  test('denies vote when same lastLogTerm but candidate log is shorter', () => {
    log.append(1, stroke());
    log.append(1, stroke());

    const result = raft.handleRequestVote({
      term:         1,
      candidateId:  'replica2',
      lastLogIndex: 1, // candidate has 1 entry; we have 2
      lastLogTerm:  1,
    });
    expect(result.voteGranted).toBe(false);
  });

  test('grants vote when candidate lastLogTerm is higher regardless of index', () => {
    log.append(1, stroke()); // our log: 1 entry, term 1

    const result = raft.handleRequestVote({
      term:         2,
      candidateId:  'replica2',
      lastLogIndex: 1, // candidate: 1 entry ...
      lastLogTerm:  2, // ... but with higher term — wins
    });
    expect(result.voteGranted).toBe(true);
  });

  test('transitions state to Follower when candidate has higher term', () => {
    raft.handleRequestVote({
      term: 10, candidateId: 'replica2', lastLogIndex: 0, lastLogTerm: 0,
    });
    expect(raft.getStatus().state).toBe('Follower');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleHeartbeat()
// ─────────────────────────────────────────────────────────────────────────────

describe('handleHeartbeat()', () => {
  test('rejects a stale heartbeat (term < currentTerm)', () => {
    // Advance our term first
    raft.handleRequestVote({ term: 5, candidateId: 'replica2', lastLogIndex: 0, lastLogTerm: 0 });

    const result = raft.handleHeartbeat({
      term: 2, leaderId: 'replica2', leaderCommit: 0,
    });
    expect(result.success).toBe(false);
    expect(result.term).toBe(5);
  });

  test('accepts a valid heartbeat from the current term', () => {
    const result = raft.handleHeartbeat({
      term: 1, leaderId: 'replica2', leaderCommit: 0,
    });
    expect(result.success).toBe(true);
  });

  test('updates currentLeader on valid heartbeat', () => {
    raft.handleHeartbeat({ term: 1, leaderId: 'replica2', leaderCommit: 0 });
    expect(raft.getStatus().leader).toBe('replica2');
  });

  test('steps down to Follower when heartbeat term is higher', () => {
    raft.handleHeartbeat({ term: 7, leaderId: 'replica3', leaderCommit: 0 });
    expect(raft.getStatus().state).toBe('Follower');
    expect(raft.getStatus().term).toBe(7);
  });

  test('advances commitIndex when leaderCommit > our commitIndex', () => {
    // Add two entries to the log (uncommitted)
    log.append(1, stroke('a'));
    log.append(1, stroke('b'));

    raft.handleHeartbeat({ term: 1, leaderId: 'replica2', leaderCommit: 2, boardCommits: { 'board-public': 2 } });

    expect(raft.getStatus().commitIndex).toBe(2);
    expect(log.getEntry(1).committed).toBe(true);
    expect(log.getEntry(2).committed).toBe(true);
  });

  test('does not advance commitIndex beyond our log length', () => {
    log.append(1, stroke()); // only 1 entry, leader says commit up to 5

    raft.handleHeartbeat({ term: 1, leaderId: 'replica2', leaderCommit: 5, boardCommits: { 'board-public': 5 } });

    // Min(5, logLength=1) = 1
    expect(raft.getStatus().commitIndex).toBe(1);
  });

  test('does not regress commitIndex when leaderCommit < ours', () => {
    log.append(1, stroke());
    raft.handleHeartbeat({ term: 1, leaderId: 'replica2', leaderCommit: 1, boardCommits: { 'board-public': 1 } });
    const ci1 = raft.getStatus().commitIndex;

    // Another heartbeat with leaderCommit = 0 (stale) — no boardCommits so no regression
    raft.handleHeartbeat({ term: 1, leaderId: 'replica2', leaderCommit: 0 });
    expect(raft.getStatus().commitIndex).toBe(ci1);
  });

  test('includes logLength in the success response so the leader can detect lagging followers', () => {
    log.append(1, stroke('a'));
    log.append(1, stroke('b'));

    const result = raft.handleHeartbeat({ term: 1, leaderId: 'replica2', leaderCommit: 0 });

    expect(result.success).toBe(true);
    expect(result.logLength).toBe(2); // follower reports its current log size
  });

  test('logLength in response is 0 when the log is empty (restarted node)', () => {
    // Fresh start — log is empty
    const result = raft.handleHeartbeat({ term: 1, leaderId: 'replica2', leaderCommit: 0 });
    expect(result.logLength).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleAppendEntries()
// ─────────────────────────────────────────────────────────────────────────────

describe('handleAppendEntries()', () => {
  const validBase = {
    term:         1,
    leaderId:     'replica2',
    prevLogIndex: 0,
    prevLogTerm:  0,
    leaderCommit: 0,
  };

  test('rejects when RPC term < currentTerm', () => {
    // Advance our term
    raft.handleRequestVote({ term: 5, candidateId: 'replica2', lastLogIndex: 0, lastLogTerm: 0 });

    const result = raft.handleAppendEntries({ ...validBase, term: 2 });
    expect(result.success).toBe(false);
    expect(result.term).toBe(5);
  });

  test('succeeds with no entry (heartbeat-style append)', () => {
    const result = raft.handleAppendEntries({ ...validBase, entry: undefined });
    expect(result.success).toBe(true);
  });

  test('appends a new entry when prevLog check passes', () => {
    const entry = { index: 1, term: 1, stroke: stroke('red') };
    const result = raft.handleAppendEntries({ ...validBase, entry });

    expect(result.success).toBe(true);
    expect(log.lastIndex()).toBe(1);
    expect(log.getEntry(1).stroke).toEqual(stroke('red'));
  });

  test('rejects when prevLogIndex entry does not exist (we are behind)', () => {
    // We have 0 entries; leader says prevLogIndex=1
    const result = raft.handleAppendEntries({
      ...validBase,
      term:         1,
      prevLogIndex: 1,
      prevLogTerm:  1,
      entry:        { index: 2, term: 1, stroke: stroke() },
    });
    expect(result.success).toBe(false);
    expect(result.logLength).toBe(0);
  });

  test('rejects on prevLogTerm mismatch (log divergence)', () => {
    log.append(2, stroke()); // entry at index 1 with term 2

    const result = raft.handleAppendEntries({
      ...validBase,
      term:         2,
      prevLogIndex: 1,
      prevLogTerm:  1, // wrong — our entry at index 1 has term 2
      entry:        { index: 2, term: 2, stroke: stroke() },
    });
    expect(result.success).toBe(false);
  });

  test('is idempotent when identical entry already exists (no-op)', () => {
    log.append(1, stroke('red'));

    // Same entry again
    const result = raft.handleAppendEntries({
      ...validBase,
      term:         1,
      prevLogIndex: 0,
      entry:        { index: 1, term: 1, stroke: stroke('red') },
    });

    expect(result.success).toBe(true);
    expect(log.lastIndex()).toBe(1); // no duplicate added
  });

  test('truncates and re-appends when there is a term conflict', () => {
    log.append(1, stroke('old')); // index 1, term 1

    // Leader sends index 1 with term 2 — conflict
    const result = raft.handleAppendEntries({
      ...validBase,
      term:         2,
      entry:        { index: 1, term: 2, stroke: stroke('new') },
    });

    expect(result.success).toBe(true);
    expect(log.getEntry(1).term).toBe(2);
    expect(log.getEntry(1).stroke).toEqual(stroke('new'));
  });

  test('advances commitIndex via leaderCommit', () => {
    log.append(1, stroke());
    log.append(1, stroke());

    raft.handleAppendEntries({
      ...validBase,
      term:         1,
      prevLogIndex: 0,
      entry:        { index: 1, term: 1, stroke: stroke() },
      leaderCommit: 2,
    });

    expect(raft.getStatus().commitIndex).toBe(2);
  });

  test('updates currentLeader on successful AppendEntries', () => {
    raft.handleAppendEntries({ ...validBase, entry: undefined });
    expect(raft.getStatus().leader).toBe('replica2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleSyncLog()
// ─────────────────────────────────────────────────────────────────────────────

describe('handleSyncLog()', () => {
  const baseSync = {
    term:         1,
    leaderId:     'replica2',
    entries:      [],
    leaderCommit: 0,
  };

  test('rejects when term < currentTerm', () => {
    raft.handleRequestVote({ term: 5, candidateId: 'replica2', lastLogIndex: 0, lastLogTerm: 0 });
    const result = raft.handleSyncLog({ ...baseSync, term: 2 });
    expect(result.success).toBe(false);
  });

  test('appends all missing entries from leader', () => {
    const entries = [
      { index: 1, term: 1, stroke: stroke('a') },
      { index: 2, term: 1, stroke: stroke('b') },
      { index: 3, term: 1, stroke: stroke('c') },
    ];

    const result = raft.handleSyncLog({ ...baseSync, entries, leaderCommit: 3 });

    expect(result.success).toBe(true);
    expect(result.logLength).toBe(3);
    expect(log.getEntry(1).stroke).toEqual(stroke('a'));
    expect(log.getEntry(3).stroke).toEqual(stroke('c'));
  });

  test('is idempotent: skips entries already present with same term', () => {
    log.append(1, stroke('a')); // index 1, term 1

    const entries = [{ index: 1, term: 1, stroke: stroke('a') }]; // exact match
    raft.handleSyncLog({ ...baseSync, entries });

    expect(log.lastIndex()).toBe(1); // not duplicated
  });

  test('replaces conflicting entries (term mismatch)', () => {
    log.append(1, stroke('old')); // term 1

    const entries = [{ index: 1, term: 2, stroke: stroke('new') }]; // leader has term 2
    raft.handleSyncLog({ ...baseSync, term: 2, entries });

    expect(log.getEntry(1).term).toBe(2);
    expect(log.getEntry(1).stroke).toEqual(stroke('new'));
  });

  test('advances commitIndex after bulk sync', () => {
    const entries = [
      { index: 1, term: 1, stroke: stroke('a') },
      { index: 2, term: 1, stroke: stroke('b') },
    ];
    raft.handleSyncLog({ ...baseSync, entries, leaderCommit: 2 });

    expect(raft.getStatus().commitIndex).toBe(2);
    expect(log.getEntry(2).committed).toBe(true);
  });

  test('updates currentLeader on sync', () => {
    raft.handleSyncLog({ ...baseSync, entries: [] });
    expect(raft.getStatus().leader).toBe('replica2');
  });

  test('returns logLength matching actual log after sync', () => {
    const entries = [
      { index: 1, term: 1, stroke: stroke() },
      { index: 2, term: 1, stroke: stroke() },
    ];
    const result = raft.handleSyncLog({ ...baseSync, entries });
    expect(result.logLength).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendHeartbeats() — proactive catch-up: trigger /sync-log for lagging followers
// ─────────────────────────────────────────────────────────────────────────────

describe('sendHeartbeats() — proactive sync-log trigger', () => {
  /**
   * Helper: drive the node to Leader state via fake timers + mocked votes.
   * After this returns, state === 'Leader', currentTerm === 1, commitIndex === 0.
   */
  async function driveToLeader() {
    axiosMock.post.mockResolvedValue({ data: { term: 1, voteGranted: true, success: true } });
    raft.start();
    // startup delay = 200 ms (replica1) → becomeFollower(0) → election timer (500–800 ms)
    // worst case: 200 + 800 = 1000 ms; advance 1200 ms to guarantee election fires
    await jest.advanceTimersByTimeAsync(1200);
    expect(raft.getStatus().state).toBe('Leader');
  }

  /**
   * Helper: commit one stroke as Leader so commitIndex becomes 1.
   * Uses a mock that makes both peers ACK immediately.
   */
  async function commitOneStroke(color = 'red') {
    axiosMock.post.mockResolvedValue({ data: { success: true, term: 1 } });
    const result = await raft.handleClientStroke(stroke(color));
    expect(result.success).toBe(true);
    expect(raft.getStatus().commitIndex).toBe(1);
  }

  // ─── Tests ─────────────────────────────────────────────────────────────────

  test(
    'triggers /sync-log for a lagging follower detected via heartbeat response',
    async () => {
      await driveToLeader();
      await commitOneStroke('red');        // commitIndex = 1

      // Followers report logLength=0 (restarted / behind) in the next heartbeat reply
      axiosMock.post.mockClear();
      axiosMock.post.mockResolvedValue({ data: { term: 1, success: true, logLength: 0 } });

      // Advance 150 ms → one heartbeat interval fires
      await jest.advanceTimersByTimeAsync(150);

      // At least one peer must have received /sync-log
      const syncCalls = axiosMock.post.mock.calls.filter(
        ([url]) => url && url.includes('/sync-log')
      );
      expect(syncCalls.length).toBeGreaterThan(0);

      // The /sync-log payload must include the committed entry and correct leaderCommit
      const [, body] = syncCalls[0];
      expect(body.entries).toHaveLength(1);    // the one committed stroke
      expect(body.leaderCommit).toBe(1);       // leader's known commitIndex
    }
  );

  test(
    'triggers /sync-log for BOTH peers when both are lagging',
    async () => {
      await driveToLeader();
      await commitOneStroke('blue');

      axiosMock.post.mockClear();
      axiosMock.post.mockResolvedValue({ data: { term: 1, success: true, logLength: 0 } });

      await jest.advanceTimersByTimeAsync(150);

      const syncCalls = axiosMock.post.mock.calls.filter(
        ([url]) => url && url.includes('/sync-log')
      );
      // 2 peers × 1 /sync-log each
      expect(syncCalls.length).toBe(2);
    }
  );

  test(
    'does NOT trigger /sync-log when followers are already up-to-date',
    async () => {
      await driveToLeader();
      await commitOneStroke();

      axiosMock.post.mockClear();
      // Followers report logLength === commitIndex (up-to-date)
      axiosMock.post.mockResolvedValue({ data: { term: 1, success: true, logLength: 1 } });

      await jest.advanceTimersByTimeAsync(150);

      const syncCalls = axiosMock.post.mock.calls.filter(
        ([url]) => url && url.includes('/sync-log')
      );
      expect(syncCalls).toHaveLength(0);
    }
  );

  test(
    'does NOT trigger /sync-log when heartbeat response has no logLength field (older replicas)',
    async () => {
      await driveToLeader();
      await commitOneStroke();

      axiosMock.post.mockClear();
      // Response without logLength — type-guard must suppress sync
      axiosMock.post.mockResolvedValue({ data: { term: 1, success: true } });

      await jest.advanceTimersByTimeAsync(150);

      const syncCalls = axiosMock.post.mock.calls.filter(
        ([url]) => url && url.includes('/sync-log')
      );
      expect(syncCalls).toHaveLength(0);
    }
  );

  test(
    'does NOT trigger /sync-log when commitIndex is 0 (no strokes committed yet)',
    async () => {
      await driveToLeader(); // commitIndex = 0 at this point

      axiosMock.post.mockClear();
      // Even if follower reports logLength=0, 0 < 0 is false — no sync needed
      axiosMock.post.mockResolvedValue({ data: { term: 1, success: true, logLength: 0 } });

      await jest.advanceTimersByTimeAsync(150);

      const syncCalls = axiosMock.post.mock.calls.filter(
        ([url]) => url && url.includes('/sync-log')
      );
      expect(syncCalls).toHaveLength(0);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// handleClientStroke() — Non-Leader rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('handleClientStroke() — non-leader', () => {
  test('returns { success: false, error: "not leader" } when in Follower state', async () => {
    const result = await raft.handleClientStroke(stroke());
    expect(result.success).toBe(false);
    expect(result.error).toBe('not leader');
  });

  test('includes the known leader in the rejection', async () => {
    // Make us aware of the current leader via a heartbeat
    raft.handleHeartbeat({ term: 1, leaderId: 'replica2', leaderCommit: 0 });

    const result = await raft.handleClientStroke(stroke());
    expect(result.leader).toBe('replica2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleClientStroke() — Leader path (via election)
// ─────────────────────────────────────────────────────────────────────────────

describe('handleClientStroke() — leader path (election required)', () => {
  /**
   * Drive the replica to Leader state:
   *  1. start() sets a 0 ms jitter timer → becomeFollower(0) → election timer
   *  2. Advance timers past election timeout → startElection() fires
   *  3. Mocked axios returns voteGranted:true from both peers → becomeLeader()
   */
  async function becomeLeader() {
    // Vote responses: grant for both peers
    axiosMock.post.mockResolvedValue({ data: { term: 1, voteGranted: true, success: true } });

    raft.start();

    // startup delay = 200 ms (replica1) → becomeFollower(0) → election timer (500–800 ms)
    // worst case: 200 + 800 = 1000 ms; advance 1200 ms to guarantee election fires
    await jest.advanceTimersByTimeAsync(1200);
  }

  test('becomes Leader after winning election', async () => {
    await becomeLeader();
    expect(raft.getStatus().state).toBe('Leader');
  });

  test('handleClientStroke succeeds as Leader — appends, replicates, commits', async () => {
    await becomeLeader();

    // Peers respond OK to AppendEntries + Gateway /broadcast
    axiosMock.post.mockResolvedValue({ data: { success: true } });

    const result = await raft.handleClientStroke(stroke('blue'));

    expect(result.success).toBe(true);
    expect(result.index).toBe(1);
    expect(log.getEntry(1).committed).toBe(true);
    expect(raft.getStatus().commitIndex).toBe(1);
  });

  test('Leader notifies gateway after committing stroke', async () => {
    await becomeLeader();
    axiosMock.post.mockResolvedValue({ data: { success: true } });

    await raft.handleClientStroke(stroke('green'));

    // At least one call should target the gateway /broadcast endpoint
    const broadcastCall = axiosMock.post.mock.calls.find(
      ([url]) => url && url.includes('/broadcast')
    );
    expect(broadcastCall).toBeDefined();
  });

  test('Leader increments log length for each stroke', async () => {
    await becomeLeader();
    axiosMock.post.mockResolvedValue({ data: { success: true } });

    await raft.handleClientStroke(stroke('a'));
    await raft.handleClientStroke(stroke('b'));

    expect(raft.getStatus().logLength).toBe(2);
    expect(raft.getStatus().commitIndex).toBe(2);
  });

  test('Leader returns error when quorum is NOT achieved (peers unreachable)', async () => {
    await becomeLeader();

    // Both peers timeout — only self-ACK (1), majority is 2
    axiosMock.post.mockRejectedValue(new Error('ETIMEOUT'));

    const result = await raft.handleClientStroke(stroke());

    // No quorum — stroke stays uncommitted
    expect(result.success).toBe(false);
    expect(result.error).toBe('no quorum');
  });

  test('Leader steps down when peer replies with higher term', async () => {
    await becomeLeader();

    // Peer returns a higher term
    axiosMock.post.mockResolvedValue({ data: { term: 99, success: false } });

    await raft.handleClientStroke(stroke());

    expect(raft.getStatus().state).toBe('Follower');
    expect(raft.getStatus().term).toBe(99);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scalability: 4-node cluster quorum correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('scalability quorum (4-node cluster)', () => {
  const FOUR_NODE_CONFIG = {
    ...TEST_CONFIG,
    PEERS: [
      'http://replica2:4002',
      'http://replica3:4003',
      'http://replica4:4004',
    ],
  };

  async function loadFourNodeLeader() {
    jest.resetModules();

    const axios4 = {
      post: jest.fn().mockResolvedValue({ data: { term: 1, voteGranted: true, success: true } }),
      get:  jest.fn().mockResolvedValue({ data: { state: 'Leader' } }),
    };

    jest.doMock('axios',                 () => axios4);
    jest.doMock('../../replica1/config', () => FOUR_NODE_CONFIG);

    const raft4 = require('../../replica1/raft');
    // Get the default board log from this fresh raft instance
    const log4  = raft4._getDefaultLog();

    raft4.start();
    // startup delay = 200 ms (replica1 idDigit=1) → becomeFollower(0) → election timer (500–800 ms)
    // worst case: 200 + 800 = 1000 ms; advance 1200 ms to guarantee election fires
    await jest.advanceTimersByTimeAsync(1200);
    expect(raft4.getStatus().state).toBe('Leader');

    return { raft4, log4, axios4 };
  }

  test('commits when self + 2 peers ACK (majority 3 of 4)', async () => {
    const { raft4, log4, axios4 } = await loadFourNodeLeader();

    axios4.post.mockClear();
    axios4.post.mockImplementation((url) => {
      if (url.includes('/append-entries') && (url.includes('replica2') || url.includes('replica3'))) {
        return Promise.resolve({ data: { success: true, term: 1 } });
      }
      if (url.includes('/append-entries') && url.includes('replica4')) {
        return Promise.reject(new Error('ETIMEOUT'));
      }
      if (url.includes('/broadcast')) {
        return Promise.resolve({ data: { success: true } });
      }
      return Promise.resolve({ data: { success: true, term: 1 } });
    });

    const result = await raft4.handleClientStroke(stroke('teal'));

    expect(result.success).toBe(true);
    expect(log4.getEntry(1).committed).toBe(true);
    expect(raft4.getStatus().commitIndex).toBe(1);
  });

  test('does not commit when only self + 1 peer ACK (below majority 3 of 4)', async () => {
    const { raft4, axios4 } = await loadFourNodeLeader();

    axios4.post.mockClear();
    axios4.post.mockImplementation((url) => {
      if (url.includes('/append-entries') && url.includes('replica2')) {
        return Promise.resolve({ data: { success: true, term: 1 } });
      }
      if (url.includes('/append-entries')) {
        return Promise.reject(new Error('ETIMEOUT'));
      }
      if (url.includes('/broadcast')) {
        return Promise.resolve({ data: { success: true } });
      }
      return Promise.resolve({ data: { success: true, term: 1 } });
    });

    const result = await raft4.handleClientStroke(stroke('orange'));

    expect(result.success).toBe(false);
    expect(result.error).toBe('no quorum');
  });
});
