# Mini-RAFT Drawing Board — Test Suite

This directory contains the full test suite for the Mini-RAFT Drawing Board project, organised into three layers: **Unit**, **Integration**, and **Chaos**.

---

## Directory Layout

```
tests/
├── package.json                  ← Jest runner + dependencies
├── README.md                     ← This file
├── helpers/
│   ├── wait.js                   ← pollUntil, pollClusterUntil, sleep, exec
│   └── wsClient.js               ← Promise-based WebSocket test client
├── unit/
│   ├── log.test.js               ← StrokeLog unit tests (18+ assertions)
│   ├── raft.test.js              ← RAFT state machine unit tests (30+ assertions)
│   └── leaderTracker.test.js     ← Gateway leader tracker unit tests (20+ assertions)
├── integration/
│   └── cluster.test.js           ← Live cluster integration tests (5 scenarios)
└── chaos/
    └── chaos.test.js             ← Chaos tests (5 scenarios)
```

---

## Quick Start

### 1. Install test dependencies

```bash
cd tests
npm install
```

### 2. Run unit tests (no Docker needed)

```bash
npm run test:unit
```

### 3. Run integration tests (requires running cluster)

```bash
# From project root — start the cluster first
docker compose up --build -d

# Then run integration tests
cd tests
npm run test:integration
```

### 4. Run chaos tests (requires running cluster)

```bash
cd tests
npm run test:chaos
```

### 5. Run everything

```bash
cd tests
npm run test:all
```

---

## Test Layer Reference

### Unit Tests — `tests/unit/`

No Docker, no network. All external dependencies are mocked with Jest.

| File | What is tested | Key technique |
|---|---|---|
| `log.test.js` | `StrokeLog` — append, getEntry, lastIndex/Term, getFrom, commit, truncateFrom, getCommitted, length | `jest.resetModules()` for fresh singleton per test |
| `raft.test.js` | All exported handlers — handleRequestVote, handleHeartbeat, handleAppendEntries, handleSyncLog, handleClientStroke; state transitions via election | `jest.doMock` for axios + config; `jest.advanceTimersByTimeAsync` for election flow |
| `leaderTracker.test.js` | discoverLeader, forwardStroke success/failure/hint, queue guard, onLeaderChange | `jest.doMock` for axios; `process.env.REPLICAS` control |

#### Running unit tests in watch mode

```bash
cd tests
npx jest unit/ --watch
```

---

### Integration Tests — `tests/integration/cluster.test.js`

Requires the full Docker cluster running (`docker compose up --build -d`). Tests **auto-skip** if `localhost:4001` is unreachable.

| ID | Scenario | Pass Condition |
|---|---|---|
| IT-1 | Leader election on startup | Exactly 1 Leader; all replicas agree on leader ID and term |
| IT-2 | Leader election after failure | New leader elected within 8 s of stopping old one |
| IT-3 | Stroke replication | All 3 replicas have identical `logLength` after a stroke |
| IT-4 | End-to-end drawing (2 WS tabs) | Tab B receives `stroke-committed` after Tab A draws |
| IT-5 | Catch-up on restart | Stopped follower rejoins and matches leader `logLength` |

#### Expected output

```
PASS integration/cluster.test.js
  [IT-1] Leader election on startup
    ✓ exactly one replica reports state="Leader"
    ✓ all replicas agree on the same leader ID
    ✓ all replicas are in the same term
    ✓ gateway /health reports a non-null leader
  [IT-2] Leader election after failure
    ✓ a new Leader is elected within 3 s after stopping the current Leader
  [IT-3] Stroke replication
    ✓ POST stroke to leader → all 3 replicas have matching logLength
    ✓ commitIndex matches logLength on all replicas after stroke
  [IT-4] End-to-end drawing (2 browser tabs)
    ✓ stroke drawn in Tab A appears in Tab B within 200 ms
    ✓ Tab A also receives its own committed stroke echoed back
    ✓ ping → pong keep-alive works on a connected tab
    ✓ invalid stroke payload → gateway returns error message
    ✓ late-joining Tab C receives full-sync with all prior strokes
  [IT-5] Catch-up on restart
    ✓ stopped follower restarts and catches up to leader logLength
```

---

### Chaos Tests — `tests/chaos/chaos.test.js`

Also requires the Docker cluster. Tests **auto-skip** if unreachable. Run with `--runInBand` (already configured) to avoid parallel Docker commands colliding.

| ID | Scenario | Method | Pass Condition |
|---|---|---|---|
| CT-1 | Kill leader during active drawing | `docker stop <leader>` while WS tab sends strokes | New leader elected; gateway queue drains; commitIndex > baseline |
| CT-2 | Hot-reload follower during replication | `docker restart <follower>` while strokes in-flight | Follower catches up; all replicas have equal `logLength` |
| CT-3 | Rapid leader restarts (3×) | `docker restart <leader>` × 3 within ~10 s | Cluster stabilises; post-chaos stroke commits successfully |
| CT-4 | Sequential restart all replicas | Restart r1 → r2 → r3 one by one | Gateway healthy; new stroke commits after all restarts |
| CT-5 | 10 concurrent tabs drawing | 10 WS connections all send strokes simultaneously | All tabs receive `stroke-committed`; replica logs are identical; indices are monotonic |

> **Note:** Chaos tests modify Docker container state. Each `describe` block has an `afterAll` that restarts stopped containers to restore the cluster for subsequent tests.

---

## Container Name Convention

The tests use the default Docker Compose project name derived from the folder name:

```
mini-raft-drawing-board-replica1-1
mini-raft-drawing-board-replica2-1
mini-raft-drawing-board-replica3-1
```

If your container names differ (e.g. you used `-p` flag with compose), update the `CONTAINERS` object in `integration/cluster.test.js` and `chaos/chaos.test.js`.

---

## Architecture Notes

### `WsTestClient` — race-safe message waiting

The helper registers a listener **before** sending the stroke, eliminating the race condition where `stroke-committed` arrives before the `.waitForType()` call:

```js
// ✅ Correct — no race
const received = tab.expectStrokeCommitted(5000);  // register first
tab.send({ type: 'stroke', data: myStroke });       // then send
const msg = await received;

// ❌ Wrong — message could arrive before listener is registered
tab.send({ type: 'stroke', data: myStroke });
const msg = await tab.waitForType('stroke-committed'); // too late?
```

### `pollUntil` vs `pollClusterUntil`

- **`pollUntil(fn, timeoutMs)`** — generic poller; resolves when `fn()` returns truthy.
- **`pollClusterUntil(axios, BASE, predicate, timeoutMs)`** — specific to the cluster; calls all 3 `/status` endpoints in parallel and passes the array to `predicate`.

---

## CI Integration

To run unit tests in CI (GitHub Actions, etc.) without Docker:

```yaml
- name: Run unit tests
  run: |
    cd tests
    npm install
    npm run test:unit
```

To run integration + chaos tests in CI with Docker Compose:

```yaml
- name: Start cluster
  run: docker compose up --build -d

- name: Wait for cluster
  run: sleep 10

- name: Run integration tests
  run: cd tests && npm run test:integration

- name: Run chaos tests
  run: cd tests && npm run test:chaos

- name: Stop cluster
  run: docker compose down
  if: always()
```
