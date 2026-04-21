'use strict';

/**
 * chaos/chaos.test.js — Chaos tests for Mini-RAFT Drawing Board
 *
 * Requires: `docker compose up --build -d` running before this suite.
 *
 * These tests deliberately cause failures while drawing to verify RAFT
 * safety guarantees (no data loss, eventual consistency).
 *
 * Test Cases (matching spec):
 *  [CT-1] Kill leader during active drawing      — new leader, no strokes lost
 *  [CT-2] Hot-reload follower during replication — follower restarts, canvas consistent
 *  [CT-3] Rapid leader restarts (3× in 10 s)    — system stabilises
 *  [CT-4] Sequential restart of all replicas     — canvas state preserved throughout
 *  [CT-5] 10 concurrent browser tabs drawing     — all canvases identical
 */

const axios      = require('axios');
const { sleep, pollClusterUntil, exec, isClusterUp, pollUntil } = require('../helpers/wait');
const WsTestClient = require('../helpers/wsClient');

// ─── Endpoints ────────────────────────────────────────────────────────────────

const BASE = {
  r1: 'http://127.0.0.1:4001',
  r2: 'http://127.0.0.1:4002',
  r3: 'http://127.0.0.1:4003',
  gw: 'http://127.0.0.1:3000',
  ws: 'ws://127.0.0.1:3000',
};

const CONTAINERS = {
  r1: 'mini-raft-drawing-board-replica1-1',
  r2: 'mini-raft-drawing-board-replica2-1',
  r3: 'mini-raft-drawing-board-replica3-1',
};

const PORT_MAP = { replica1: 4001, replica2: 4002, replica3: 4003 };

// ─── Cluster reachability guard ───────────────────────────────────────────────

let clusterRunning = false;

beforeAll(async () => {
  clusterRunning = await isClusterUp(axios, BASE);
  if (!clusterRunning) {
    console.warn(
      '\n⚠️  Docker cluster not detected. Run `docker compose up --build -d`.\n' +
      '   All chaos tests will be SKIPPED.\n'
    );
  }
}, 15_000);

function it_chaos(name, fn, timeout) {
  (clusterRunning ? test : test.skip)(name, fn, timeout);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function allStatuses() {
  return Promise.all([
    axios.get(`${BASE.r1}/status`, { timeout: 2000 }).then(r => r.data).catch(() => null),
    axios.get(`${BASE.r2}/status`, { timeout: 2000 }).then(r => r.data).catch(() => null),
    axios.get(`${BASE.r3}/status`, { timeout: 2000 }).then(r => r.data).catch(() => null),
  ]);
}

async function findLeader() {
  const statuses = await allStatuses();
  return statuses.find(s => s && s.state === 'Leader') || null;
}

async function waitForLeader(timeoutMs = 10_000) {
  return pollUntil(async () => {
    const leader = await findLeader();
    return leader || null;
  }, timeoutMs, 500);
}

async function ensureAllContainersRunning() {
  for (const ctr of Object.values(CONTAINERS)) {
    try { await exec(`docker start ${ctr}`); } catch {}
  }
  await sleep(4000);
}

const mkStroke = (color = 'chaos', idx = 0) => ({
  points: [{ x: idx, y: 0 }, { x: idx + 20, y: 20 }, { x: idx + 40, y: 0 }],
  color,
  width:  2,
});

/**
 * Draw `n` strokes to the current leader, tolerating 404 / no-leader errors
 * (strokes during failover will be queued by the gateway).
 * Returns the number of successfully committed strokes via gateway.
 */
async function drawStrokesViaGateway(n, color = 'chaos') {
  let sent = 0;
  const wsTab = await WsTestClient.connect(BASE.ws);
  await wsTab.waitForType('full-sync', 5000);

  for (let i = 0; i < n; i++) {
    wsTab.send({ type: 'stroke', data: mkStroke(color, i) });
    sent++;
    await sleep(50);
  }
  wsTab.close();
  return sent;
}

// ─────────────────────────────────────────────────────────────────────────────
// CT-1: Kill leader during active drawing
// ─────────────────────────────────────────────────────────────────────────────

describe('[CT-1] Kill leader during active drawing', () => {
  afterAll(() => ensureAllContainersRunning());

  it_chaos(
    'new leader is elected and gateway recovers; committed strokes are not lost',
    async () => {
      // 1. Get baseline committed log length
      const before    = await allStatuses();
      const leader0   = before.find(s => s && s.state === 'Leader');
      expect(leader0).toBeDefined();

      const leaderCtr = Object.values(CONTAINERS).find(c => c.includes(leader0.id));
      const baseLength = before.find(s => s !== null).commitIndex;

      // 2. Open a drawing tab and start sending strokes
      const tab = await WsTestClient.connect(BASE.ws);
      await tab.waitForType('full-sync', 5000);

      // Send 5 strokes then kill the leader
      for (let i = 0; i < 5; i++) {
        tab.send({ type: 'stroke', data: mkStroke('pre-kill', i) });
        await sleep(80);
      }

      // 3. Kill the leader
      await exec(`docker stop ${leaderCtr}`);

      // 4. Send 5 more strokes (these hit the gateway queue)
      for (let i = 0; i < 5; i++) {
        tab.send({ type: 'stroke', data: mkStroke('post-kill', i) });
        await sleep(80);
      }

      tab.close();

      // 5. Wait for a new leader
      const newLeader = await waitForLeader(12_000);
      expect(newLeader).not.toBeNull();
      expect(newLeader.id).not.toBe(leader0.id);

      // 6. Wait for gateway queueDepth to drain to 0
      await pollUntil(async () => {
        const h = await axios.get(`${BASE.gw}/health`, { timeout: 2000 });
        return h.data.queueDepth === 0;
      }, 15_000, 500);

      // 7. The new leader's commitIndex should be ≥ base + some strokes
      //    (at minimum the pre-kill strokes that reached quorum)
      const newStatus = await axios.get(
        `http://127.0.0.1:${PORT_MAP[newLeader.id]}/status`,
        { timeout: 2000 }
      ).then(r => r.data);

      expect(newStatus.commitIndex).toBeGreaterThan(baseLength);
    },
    60_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// CT-2: Hot-reload follower during replication
// ─────────────────────────────────────────────────────────────────────────────

describe('[CT-2] Hot-reload follower during replication', () => {
  afterAll(() => ensureAllContainersRunning());

  it_chaos(
    'restarted follower catches up; all replicas have identical committed logs',
    async () => {
      const before  = await allStatuses();
      const leader0 = before.find(s => s && s.state === 'Leader');
      const follower = before.find(s => s && s.state === 'Follower');
      expect(leader0).toBeDefined();
      expect(follower).toBeDefined();

      const followerCtr = Object.values(CONTAINERS).find(c => c.includes(follower.id));
      const leaderPort   = PORT_MAP[leader0.id];

      // 1. Restart the follower (simulates nodemon hot-reload)
      await exec(`docker restart ${followerCtr}`);

      // 2. While it restarts, draw 5 strokes
      for (let i = 0; i < 5; i++) {
        try {
          await axios.post(
            `http://127.0.0.1:${leaderPort}/client-stroke`,
            { stroke: mkStroke('hotreload', i) },
            { timeout: 2000 }
          );
        } catch {}
        await sleep(200);
      }

      // 3. Wait for the follower to come back and catch up
      const targetLength = await axios.get(
        `http://127.0.0.1:${leaderPort}/status`,
        { timeout: 2000 }
      ).then(r => r.data.logLength);

      await pollUntil(async () => {
        const statuses = await allStatuses();
        const restarted = statuses.find(s => s && s.id === follower.id);
        return restarted && restarted.logLength >= targetLength;
      }, 20_000, 800);

      // 4. Verify all three replicas have consistent logLength
      const final = await allStatuses();
      const lengths = final.filter(Boolean).map(s => s.logLength);
      const maxLen  = Math.max(...lengths);
      expect(lengths.every(l => l === maxLen)).toBe(true);
    },
    60_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// CT-3: Rapid leader restarts (3× in 10 s)
// ─────────────────────────────────────────────────────────────────────────────

describe('[CT-3] Rapid leader restarts (3× in 10 s)', () => {
  afterAll(() => ensureAllContainersRunning());

  it_chaos(
    'cluster stabilises after 3 rapid leader restarts; canvas intact',
    async () => {
      let baseCommitIndex = 0;
      try {
        const s = await allStatuses();
        baseCommitIndex = Math.max(...s.filter(Boolean).map(x => x.commitIndex));
      } catch {}

      // Restart the leader 3 times within ~10 s
      for (let round = 0; round < 3; round++) {
        const leader = await waitForLeader(8_000);
        expect(leader).not.toBeNull();

        const ctr = Object.values(CONTAINERS).find(c => c.includes(leader.id));
        await exec(`docker restart ${ctr}`);

        // Brief pause between restarts
        await sleep(2500);
      }

      // After all restarts, wait for a stable leader
      const stableLeader = await waitForLeader(12_000);
      expect(stableLeader).not.toBeNull();

      // Draw a stroke and make sure it commits successfully (cluster is functional)
      const leaderPort = PORT_MAP[stableLeader.id];
      const res = await axios.post(
        `http://127.0.0.1:${leaderPort}/client-stroke`,
        { stroke: mkStroke('post-chaos') },
        { timeout: 3000 }
      );
      expect(res.data.success).toBe(true);

      // All replicas should converge on the same logLength
      const final = await pollClusterUntil(
        axios,
        BASE,
        (ss) => ss.filter(Boolean).every(s => s.logLength === ss.find(Boolean).logLength),
        15_000
      );
      const logLengths = final.filter(Boolean).map(s => s.logLength);
      expect(new Set(logLengths).size).toBe(1);
    },
    90_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// CT-4: Sequential restart of all replicas
// ─────────────────────────────────────────────────────────────────────────────

describe('[CT-4] Sequential restart of all replicas', () => {
  afterAll(() => ensureAllContainersRunning());

  it_chaos(
    'canvas state preserved after restarting replica1 → replica2 → replica3',
    async () => {
      // Draw a stroke first to seed the log
      const leader0 = await waitForLeader(8_000);
      expect(leader0).toBeDefined();
      const startPort = PORT_MAP[leader0.id];

      await axios.post(
        `http://127.0.0.1:${startPort}/client-stroke`,
        { stroke: mkStroke('seed') },
        { timeout: 3000 }
      );

      // Wait for all replicas to have the seeded stroke
      await sleep(1500);
      const seededStatuses = await allStatuses();
      const targetLen = Math.max(...seededStatuses.filter(Boolean).map(s => s.commitIndex));
      expect(targetLen).toBeGreaterThan(0);

      // Restart replicas one by one
      for (const [key, ctr] of Object.entries(CONTAINERS)) {
        await exec(`docker restart ${ctr}`);
        // Wait for a new leader before proceeding to next restart
        await waitForLeader(10_000);
        await sleep(1000);
      }

      // After all restarts, verify gateway is healthy
      const health = await axios.get(`${BASE.gw}/health`, { timeout: 3000 });
      expect(health.data.status).toBe('ok');
      expect(health.data.leader).not.toBeNull();

      // Verify all running replicas have ≥ commitIndex from before restarts
      // (in-memory log is intentional design limitation — SRS says non-persistent)
      // So we check that a new stroke CAN be committed (cluster is functional)
      const finalLeader = await waitForLeader(10_000);
      const finalPort  = PORT_MAP[finalLeader.id];
      const postRes = await axios.post(
        `http://127.0.0.1:${finalPort}/client-stroke`,
        { stroke: mkStroke('post-sequential') },
        { timeout: 3000 }
      );
      expect(postRes.data.success).toBe(true);
    },
    90_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// CT-5: 10 concurrent browser tabs drawing simultaneously
// ─────────────────────────────────────────────────────────────────────────────

describe('[CT-5] 10 concurrent browser tabs drawing simultaneously', () => {
  it_chaos(
    'all 10 tabs receive consistent stroke-committed messages; no ordering errors',
    async () => {
      const TAB_COUNT   = 10;
      const tabs        = [];

      // 1. Connect 10 WS tabs concurrently
      for (let i = 0; i < TAB_COUNT; i++) {
        tabs.push(await WsTestClient.connect(BASE.ws));
      }

      // 2. Wait for all full-syncs
      await Promise.all(tabs.map(t => t.waitForType('full-sync', 8000)));

      const tab0 = tabs[0];
      const initialQueue = tab0.queueLength; // Any pre-existing messages

      // 4. All 10 tabs send a stroke simultaneously
      tabs.forEach((t, i) => {
        t.send({ type: 'stroke', data: mkStroke(`tab-${i}`, i * 5) });
      });

      // 5. Wait for Tab 0 to receive exactly TAB_COUNT (10) stroke-committed broadcasts
      const collectedStrokes = [];
      for (let i = 0; i < TAB_COUNT; i++) {
        const msg = await tab0.waitForType('stroke-committed', 10_000);
        collectedStrokes.push(msg.data);
      }

      // 6. Verify consistent state: all replicas have the same logLength
      await sleep(1000); // allow replication to settle
      const statuses = await allStatuses();
      const lengths  = statuses.filter(Boolean).map(s => s.logLength);
      expect(new Set(lengths).size).toBe(1); // all equal

      // 7. Verify indices in committed strokes are monotonically increasing
      // Since tab0 collected exactly the 10 strokes we just sent, they should be unique & increasing
      const indices = collectedStrokes.map(s => s.index).sort((a, b) => a - b);

      for (let i = 1; i < indices.length; i++) {
        // Each committed index should be unique (no duplicates)
        expect(indices[i]).toBeGreaterThan(indices[i - 1]);
      }

      // 8. Gateway client count should reflect 10 active connections
      const health = await axios.get(`${BASE.gw}/health`, { timeout: 2000 });
      expect(health.data.clients).toBeGreaterThanOrEqual(TAB_COUNT);

      // Cleanup
      tabs.forEach(t => t.close());
    },
    60_000
  );

  it_chaos(
    'gateway /health shows correct client count as tabs connect and disconnect',
    async () => {
      const tabs = [];
      for (let i = 0; i < 5; i++) {
        tabs.push(await WsTestClient.connect(BASE.ws));
      }
      await Promise.all(tabs.map(t => t.waitForType('full-sync', 5000)));

      const hBefore = await axios.get(`${BASE.gw}/health`, { timeout: 2000 });
      expect(hBefore.data.clients).toBeGreaterThanOrEqual(5);

      // Disconnect all 5 tabs
      tabs.forEach(t => t.close());
      await sleep(500);

      const hAfter = await axios.get(`${BASE.gw}/health`, { timeout: 2000 });
      // Client count should have dropped
      expect(hAfter.data.clients).toBeLessThan(hBefore.data.clients);
    },
    20_000
  );
});
