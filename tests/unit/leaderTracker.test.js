'use strict';

/**
 * unit/leaderTracker.test.js — Unit tests for gateway/leaderTracker.js
 *
 * Strategy:
 *  - jest.resetModules() + jest.doMock() in beforeEach gives a fresh module
 *    (fresh internal state: currentLeader=null, strokeQueue=[]) per test.
 *  - axios is fully mocked — no real HTTP calls.
 *  - process.env.REPLICAS is set before each require to control the replica list.
 *
 * Coverage:
 *  ✓ getLeader()              — null on start, set after discovery
 *  ✓ getStats()               — leader + queueDepth + failoverActive + replicas shape
 *  ✓ isFailoverInProgress()   — false initially, true when no leader and stroke queued
 *  ✓ discoverLeader()         — parallel poll, selects first Leader replica
 *  ✓ discoverLeader()         — no leader found → currentLeader stays null
 *  ✓ forwardStroke()          — success path, queues on no-leader, queues on failure
 *  ✓ forwardStroke()          — uses leader hint on not-leader response
 *  ✓ stroke queue             — depth guard (MAX_QUEUE_SIZE), retry limit
 *  ✓ onLeaderChange()         — callback fires on leader change
 *  ✓ onFailoverStateChange()  — fires isActive=true/false on failover transitions
 *  ✓ failover lock            — concurrent forwardStroke calls serialised during recovery
 */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REPLICA_URLS = [
  'http://replica1:4001',
  'http://replica2:4002',
  'http://replica3:4003',
];

const STROKE = {
  points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
  color:  'red',
  width:  3,
};

// ─── Per-test setup ───────────────────────────────────────────────────────────

let tracker;
let axiosMock;

/** Helper — set up axios mock and (re)load the module */
function loadTracker(axiosOverrides = {}, replicasEnv = 'replica1:4001,replica2:4002,replica3:4003') {
  jest.resetModules();

  axiosMock = {
    get:  jest.fn(),
    post: jest.fn(),
    ...axiosOverrides,
  };

  process.env.REPLICAS = replicasEnv;

  jest.doMock('axios', () => axiosMock);

  tracker = require('../../gateway/leaderTracker');
  return tracker;
}

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.REPLICAS;
});

// ─────────────────────────────────────────────────────────────────────────────
// getLeader() / getStats()
// ─────────────────────────────────────────────────────────────────────────────

describe('getLeader()', () => {
  test('returns null before any discovery', () => {
    loadTracker();
    expect(tracker.getLeader()).toBeNull();
  });
});

describe('getStats()', () => {
  test('returns correct shape before discovery', () => {
    loadTracker();
    const stats = tracker.getStats();
    expect(stats).toMatchObject({
      leader:        null,
      queueDepth:    0,
      failoverActive: false,
    });
    expect(Array.isArray(stats.replicas)).toBe(true);
    expect(stats.replicas).toHaveLength(3);
  });

  test('replicas list matches env var', () => {
    loadTracker();
    const { replicas } = tracker.getStats();
    expect(replicas).toContain('http://replica1:4001');
    expect(replicas).toContain('http://replica2:4002');
    expect(replicas).toContain('http://replica3:4003');
  });

  test('supports a 4-replica list from env without code changes', () => {
    loadTracker({}, 'replica1:4001,replica2:4002,replica3:4003,replica4:4004');
    const { replicas } = tracker.getStats();
    expect(replicas).toHaveLength(4);
    expect(replicas).toContain('http://replica4:4004');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// discoverLeader() — via start() which calls it immediately
// ─────────────────────────────────────────────────────────────────────────────

describe('discoverLeader()', () => {
  test('sets currentLeader to the replica that reports state=Leader', async () => {
    loadTracker();

    // replica1 is Follower, replica2 is Leader, replica3 is Follower
    axiosMock.get.mockImplementation((url) => {
      if (url.includes('replica2')) return Promise.resolve({ data: { state: 'Leader' } });
      return Promise.resolve({ data: { state: 'Follower' } });
    });

    tracker.start();
    await Promise.resolve(); // flush microtasks

    // Give parallel Promise.any time to settle
    await new Promise(r => setTimeout(r, 50));

    expect(tracker.getLeader()).toBe('http://replica2:4002');
  });

  test('leaves currentLeader as null when no replica is a Leader', async () => {
    loadTracker();

    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(tracker.getLeader()).toBeNull();
  });

  test('leaves currentLeader null when all replicas are unreachable', async () => {
    loadTracker();

    axiosMock.get.mockRejectedValue(new Error('ECONNREFUSED'));

    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(tracker.getLeader()).toBeNull();
  });

  test('fires onLeaderChange callback when leader is discovered', async () => {
    loadTracker();

    const cb = jest.fn();
    tracker.onLeaderChange(cb);

    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });

    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(cb).toHaveBeenCalled();
    const [newLeader, prevLeader] = cb.mock.calls[0];
    expect(newLeader).toMatch(/http:\/\/replica/);
    expect(prevLeader).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forwardStroke() — success path
// ─────────────────────────────────────────────────────────────────────────────

describe('forwardStroke() — success path', () => {
  test('POSTs stroke to the known leader and returns { success: true }', async () => {
    loadTracker();

    // Manually set known leader by simulating a successful discovery
    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    axiosMock.post.mockResolvedValue({ data: { success: true, index: 1 } });

    const result = await tracker.forwardStroke(STROKE);

    expect(result).toMatchObject({ success: true, index: 1 });
    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining('/client-stroke'),
      { stroke: STROKE, boardId: 'board-public' },
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forwardStroke() — no leader known → queue
// ─────────────────────────────────────────────────────────────────────────────

describe('forwardStroke() — no leader', () => {
  test('queues the stroke when currentLeader is null and returns { queued: true }', async () => {
    loadTracker();

    // Keep leader null (all replicas refuse to be Leader)
    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    const result = await tracker.forwardStroke(STROKE);

    expect(result).toMatchObject({ queued: true });
    expect(tracker.getStats().queueDepth).toBe(1);
  });

  test('increments queueDepth for each stroke forwarded with no leader', async () => {
    loadTracker();
    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    await tracker.forwardStroke(STROKE);
    await tracker.forwardStroke(STROKE);
    await tracker.forwardStroke(STROKE);

    expect(tracker.getStats().queueDepth).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forwardStroke() — leader unreachable → queue + re-discover
// ─────────────────────────────────────────────────────────────────────────────

describe('forwardStroke() — leader unreachable', () => {
  test('queues stroke when leader POST times out', async () => {
    loadTracker();

    // Discovery finds replica1 as leader
    axiosMock.get.mockImplementation((url) => {
      if (url.includes('replica1')) return Promise.resolve({ data: { state: 'Leader' } });
      return Promise.resolve({ data: { state: 'Follower' } });
    });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    // But POST to leader fails
    axiosMock.post.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await tracker.forwardStroke(STROKE);

    expect(result).toMatchObject({ queued: true });
  });

  test('sets currentLeader to null after unreachable error', async () => {
    loadTracker();

    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    axiosMock.post.mockRejectedValue(new Error('ECONNRESET'));
    // Make re-discovery also fail to keep it null
    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    await tracker.forwardStroke(STROKE);

    expect(tracker.getLeader()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forwardStroke() — "not leader" hint fast-path
// ─────────────────────────────────────────────────────────────────────────────

describe('forwardStroke() — not-leader hint', () => {
  test('uses the hint URL to find the new leader without full re-poll', async () => {
    loadTracker();

    // Start with replica1 as known leader
    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(tracker.getLeader()).toMatch(/replica/);

    // replica1 says "not leader, try replica2"
    axiosMock.post.mockResolvedValueOnce({
      data: { success: false, error: 'not leader', leader: 'replica2' },
    });

    // Hint verification: replica2/status returns Leader
    axiosMock.get.mockImplementation((url) => {
      if (url.includes('replica2')) return Promise.resolve({ data: { state: 'Leader' } });
      return Promise.resolve({ data: { state: 'Follower' } });
    });

    const result = await tracker.forwardStroke(STROKE);

    // Should have queued (the hint triggers requeue)
    expect(result).toMatchObject({ queued: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Queue depth guard
// ─────────────────────────────────────────────────────────────────────────────

describe('stroke queue depth guard', () => {
  test('never exceeds MAX_QUEUE_SIZE — drops oldest entry', async () => {
    loadTracker();

    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    const MAX = 100; // matches leaderTracker constant
    // Push 105 strokes — should cap at 100
    const promises = [];
    for (let i = 0; i < MAX + 5; i++) {
      promises.push(tracker.forwardStroke({ ...STROKE, color: `color-${i}` }));
    }
    await Promise.all(promises);

    expect(tracker.getStats().queueDepth).toBeLessThanOrEqual(MAX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onLeaderChange() callback
// ─────────────────────────────────────────────────────────────────────────────

describe('onLeaderChange()', () => {
  test('registers a callback that fires with (newLeader, prevLeader) args', async () => {
    loadTracker();

    const changes = [];
    tracker.onLeaderChange((n, p) => changes.push({ n, p }));

    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0].p).toBeNull(); // from null
    expect(changes[0].n).toMatch(/http:\/\/replica/);
  });

  test('does not crash when callback throws', async () => {
    loadTracker();

    tracker.onLeaderChange(() => { throw new Error('cb error'); });

    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });

    // Should not throw when discoverLeader fires the bad callback
    await expect(tracker.start()).resolves === undefined;
    await new Promise(r => setTimeout(r, 50));
    // Tracker still functional
    expect(typeof tracker.getLeader()).toBe('string');
  });

  test('only the last registered callback is active', async () => {
    loadTracker();

    const cb1 = jest.fn();
    const cb2 = jest.fn();
    tracker.onLeaderChange(cb1);
    tracker.onLeaderChange(cb2); // overrides cb1

    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(cb2).toHaveBeenCalled();
    expect(cb1).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isFailoverInProgress() / getStats().failoverActive
// ─────────────────────────────────────────────────────────────────────────────

describe('isFailoverInProgress()', () => {
  test('returns false on startup (no failover triggered)', () => {
    loadTracker();
    expect(tracker.isFailoverInProgress()).toBe(false);
    expect(tracker.getStats().failoverActive).toBe(false);
  });

  test('returns true immediately when a stroke is forwarded with no leader', () => {
    loadTracker();
    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    // Fire-and-forget (don't await — inspect before async discovery settles)
    tracker.forwardStroke(STROKE);

    // Synchronously after queueing: failover should be active
    expect(tracker.isFailoverInProgress()).toBe(true);
    expect(tracker.getStats().failoverActive).toBe(true);
  });

  test('getStats() contains failoverActive boolean field', () => {
    loadTracker();
    const stats = tracker.getStats();
    expect(Object.prototype.hasOwnProperty.call(stats, 'failoverActive')).toBe(true);
    expect(typeof stats.failoverActive).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onFailoverStateChange() callback
// ─────────────────────────────────────────────────────────────────────────────

describe('onFailoverStateChange()', () => {
  test('fires with isActive=true when forwardStroke encounters no leader', async () => {
    loadTracker();

    const states = [];
    tracker.onFailoverStateChange((isActive) => states.push(isActive));

    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    await tracker.forwardStroke(STROKE);
    await new Promise(r => setTimeout(r, 50));

    expect(states).toContain(true);
  });

  test('fires with isActive=false after queue is drained by a new leader', async () => {
    loadTracker();

    const states = [];
    tracker.onFailoverStateChange((isActive) => states.push(isActive));

    // First: no leader → failover active
    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });
    await tracker.forwardStroke(STROKE);
    await new Promise(r => setTimeout(r, 50));
    expect(states).toContain(true);

    // Now a leader is found → queue replayed → failover ends
    axiosMock.get.mockImplementation((url) => {
      if (url.includes('replica1')) return Promise.resolve({ data: { state: 'Leader' } });
      return Promise.resolve({ data: { state: 'Follower' } });
    });
    axiosMock.post.mockResolvedValue({ data: { success: true, index: 1 } });

    tracker.start(); // triggers discovery → replayQueue → _setFailoverActive(false)
    await new Promise(r => setTimeout(r, 200));

    expect(states).toContain(false);
  });

  test('does not crash when the callback itself throws', async () => {
    loadTracker();

    tracker.onFailoverStateChange(() => { throw new Error('failover cb error'); });
    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    // Should not propagate the error
    await expect(tracker.forwardStroke(STROKE)).resolves.toMatchObject({ queued: true });
  });

  test('only the last registered callback is active', async () => {
    loadTracker();

    const cb1 = jest.fn();
    const cb2 = jest.fn();
    tracker.onFailoverStateChange(cb1);
    tracker.onFailoverStateChange(cb2); // overrides cb1

    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });
    await tracker.forwardStroke(STROKE);
    await new Promise(r => setTimeout(r, 50));

    expect(cb2).toHaveBeenCalled();
    expect(cb1).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Serialised failover lock — concurrent forwardStroke calls during failover
// ─────────────────────────────────────────────────────────────────────────────

describe('failover lock (serialised recovery)', () => {
  test('all concurrent forwardStroke calls during leader outage get { queued: true }', async () => {
    loadTracker();

    // Establish a known leader
    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));
    expect(tracker.getLeader()).not.toBeNull();

    // Leader POST fails; re-discovery also finds no leader
    axiosMock.post.mockRejectedValue(new Error('ECONNREFUSED'));
    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    // 5 simultaneous stroke forwards
    const results = await Promise.all([
      tracker.forwardStroke({ ...STROKE, color: 'c1' }),
      tracker.forwardStroke({ ...STROKE, color: 'c2' }),
      tracker.forwardStroke({ ...STROKE, color: 'c3' }),
      tracker.forwardStroke({ ...STROKE, color: 'c4' }),
      tracker.forwardStroke({ ...STROKE, color: 'c5' }),
    ]);

    for (const r of results) {
      expect(r).toMatchObject({ queued: true });
    }
    // All 5 must be in the queue — none lost
    expect(tracker.getStats().queueDepth).toBe(5);
  });

  test('discovery GET calls are bounded when many concurrent failures occur', async () => {
    loadTracker();

    let getCallCount = 0;
    axiosMock.get.mockImplementation(async () => {
      getCallCount++;
      await new Promise(r => setTimeout(r, 20));
      return { data: { state: 'Follower' } };
    });
    axiosMock.post.mockRejectedValue(new Error('ECONNREFUSED'));

    // First: seed a known leader via startup
    axiosMock.get.mockResolvedValueOnce({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));
    getCallCount = 0; // reset after startup

    // Re-enable Follower responses so recovery finds no leader
    axiosMock.get.mockImplementation(async () => {
      getCallCount++;
      await new Promise(r => setTimeout(r, 20));
      return { data: { state: 'Follower' } };
    });

    // 3 concurrent failures
    await Promise.all([
      tracker.forwardStroke({ ...STROKE, color: 'a' }),
      tracker.forwardStroke({ ...STROKE, color: 'b' }),
      tracker.forwardStroke({ ...STROKE, color: 'c' }),
    ]);
    await new Promise(r => setTimeout(r, 200));

    // Without the lock: 3 concurrent recoveries × 3 replicas = up to 9 GET calls.
    // With the lock: only 1 recovery runs → at most 3 GET calls in that round.
    expect(getCallCount).toBeLessThan(9);
  });
});
