# Implementation Plan

## Distributed Real-Time Drawing Board with Mini-RAFT Consensus

| Field             | Detail                                                       |
| ----------------- | ------------------------------------------------------------ |
| **Project Title** | Distributed Real-Time Drawing Board with Mini-RAFT Consensus |
| **Version**       | 1.0                                                          |
| **Date**          | April 2026                                                   |
| **Team Size**     | 4 Members                                                    |
| **Duration**      | 3 Weeks                                                      |
| **Architecture**  | Microservices (Containerised via Docker)                     |

> **Related Documents:**
> - `SRS_Document.md` — Functional/non-functional requirements, API specs, protocol specification, and data models
> - `architecture_diagram.md` — Standalone architecture diagrams (cluster layout, state machine, sequence diagrams)
> - `Week2_Implementation_Progress.md` — Detailed record of all Week 2 changes, design decisions, and verified live cluster state

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Monorepo Directory Structure](#2-monorepo-directory-structure)
3. [Docker & Deployment Specification](#3-docker--deployment-specification)
4. [Failure Scenarios & Handling](#4-failure-scenarios--handling)
5. [Week-Wise Execution Plan](#5-week-wise-execution-plan)
6. [Testing Strategy](#6-testing-strategy)
7. [Submission Deliverables](#7-submission-deliverables)
8. [Bonus Challenges (Optional)](#8-bonus-challenges-optional)

---

## 1. Project Overview

The system consists of **4 microservices** running in Docker containers on a shared Docker network (`raft-net`):

| Service     | Container    | Port  | Role                                              |
| ----------- | ------------ | ----- | ------------------------------------------------- |
| Frontend    | `frontend`   | 8080  | Browser canvas UI                                 |
| Gateway     | `gateway`    | 3000  | WebSocket server + leader router                  |
| Replica 1   | `replica1`   | 4001  | RAFT consensus node                               |
| Replica 2   | `replica2`   | 4002  | RAFT consensus node                               |
| Replica 3   | `replica3`   | 4003  | RAFT consensus node                               |

### End-to-End Stroke Flow

```
User draws on canvas
        │
        ▼
  Frontend (WS)
        │
        ▼
  Gateway ─────────► Leader Replica
                           │
               AppendEntries to Followers
                           │
                    Majority ACK
                           │
                    Commit entry
                           │
              Notify Gateway (/broadcast)
                           │
                    Gateway broadcasts
                           │
                 All clients render stroke
```

---

## 2. Monorepo Directory Structure

```
Mini-RAFT-Drawing-Board/
├── documentation/
│   ├── SRS_Document.md           # Requirements, API specs, protocol
│   └── Implementation_Plan.md    # This document
│
├── frontend/
│   ├── index.html                # Canvas UI
│   ├── style.css
│   ├── app.js                    # WS client + drawing logic
│   └── Dockerfile
│
├── gateway/
│   ├── server.js                 # WS server + HTTP routing
│   ├── leaderTracker.js          # Leader discovery logic
│   ├── package.json
│   ├── nodemon.json
│   └── Dockerfile
│
├── replica1/                     # ─┐
│   ├── server.js                 #  │
│   ├── raft.js                   #  │ All three replicas share
│   ├── log.js                    #  │ the same code structure.
│   ├── config.js                 #  │ Differentiated only by
│   ├── package.json              #  │ environment variables.
│   ├── nodemon.json              #  │
│   └── Dockerfile                # ─┤
├── replica2/                     #  │
│   └── ...                       # ─┤
├── replica3/                     #  │
│   └── ...                       # ─┘
│
├── docker-compose.yml
├── MiniRAFT.pdf
├── MiniRAFT.txt
└── README.md
```

---

## 3. Docker & Deployment Specification

### 3.1 `docker-compose.yml`

```yaml
version: "3.8"

networks:
  raft-net:
    driver: bridge

services:

  frontend:
    build: ./frontend
    ports:
      - "8080:8080"
    networks:
      - raft-net
    depends_on:
      - gateway

  gateway:
    build: ./gateway
    ports:
      - "3000:3000"
    environment:
      - REPLICAS=replica1:4001,replica2:4002,replica3:4003
    networks:
      - raft-net
    depends_on:
      - replica1
      - replica2
      - replica3

  replica1:
    build: ./replica1
    ports:
      - "4001:4001"
    volumes:
      - ./replica1:/app          # Bind mount for hot-reload
      - /app/node_modules        # Preserve node_modules inside container
    environment:
      - REPLICA_ID=replica1
      - PORT=4001
      - PEERS=replica2:4002,replica3:4003
      - GATEWAY_URL=http://gateway:3000
    networks:
      - raft-net

  replica2:
    build: ./replica2
    ports:
      - "4002:4002"
    volumes:
      - ./replica2:/app
      - /app/node_modules
    environment:
      - REPLICA_ID=replica2
      - PORT=4002
      - PEERS=replica1:4001,replica3:4003
      - GATEWAY_URL=http://gateway:3000
    networks:
      - raft-net

  replica3:
    build: ./replica3
    ports:
      - "4003:4003"
    volumes:
      - ./replica3:/app
      - /app/node_modules
    environment:
      - REPLICA_ID=replica3
      - PORT=4003
      - PEERS=replica1:4001,replica2:4002
      - GATEWAY_URL=http://gateway:3000
    networks:
      - raft-net
```

### 3.2 Replica Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm install

COPY . .

# Install nodemon globally for hot-reload
RUN npm install -g nodemon

EXPOSE 4001

CMD ["nodemon", "--watch", ".", "--ext", "js,json", "server.js"]
```

### 3.3 Gateway Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
```

### 3.4 Frontend Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Use http-server to serve static files
RUN npm install -g http-server

COPY . .

EXPOSE 8080

CMD ["http-server", ".", "-p", "8080"]
```

### 3.5 Environment Variables Reference

| Variable       | Used By   | Example Value                       | Description                           |
| -------------- | --------- | ----------------------------------- | ------------------------------------- |
| `REPLICA_ID`   | Replicas  | `replica1`                          | Unique identifier for this replica    |
| `PORT`         | Replicas  | `4001`                              | Port this replica listens on          |
| `PEERS`        | Replicas  | `replica2:4002,replica3:4003`       | Comma-separated peer host:port list   |
| `GATEWAY_URL`  | Replicas  | `http://gateway:3000`               | Gateway URL for broadcast calls       |
| `REPLICAS`     | Gateway   | `replica1:4001,replica2:4002,...`   | All replica addresses                 |

### 3.6 Useful Docker Commands

```bash
# Start the full system
docker-compose up --build

# Start in detached mode
docker-compose up -d --build

# View logs for a specific service
docker logs -f replica1

# Stop and remove a container (simulates failure)
docker-compose stop replica1

# Restart a container (simulates hot-reload)
docker-compose restart replica1

# Shell into a running container
docker exec -it replica1 sh

# Tear down everything
docker-compose down
```

---

## 4. Failure Scenarios & Handling

| # | Scenario                              | What Happens                                                                                                                      | Expected Outcome                               |
| - | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1 | **Leader crashes** (`docker stop`)    | Followers detect missed heartbeats → election → new leader elected → Gateway polls `/status` → re-routes traffic                  | System available in < 2 s; clients unaffected  |
| 2 | **Follower crashes**                  | Leader continues with remaining quorum; crashed follower catches up on restart via `/sync-log`                                    | No data loss; sync on restart                  |
| 3 | **Leader hot-reloaded** (file edit)   | Container restarts → starts as Follower → election triggered → new leader elected → catch-up sync                                 | No client disconnect; canvas consistent        |
| 4 | **Follower hot-reloaded**             | Container restarts → starts as Follower → catches up from leader → no election needed                                             | Transparent to clients                         |
| 5 | **Two replicas crash**                | No quorum → system cannot commit new strokes → recovers automatically when ≥ 2 replicas are running                               | Read-only or queued until recovery             |
| 6 | **Split vote in election**            | Both candidates timeout → new election with new randomised timeout → one candidate wins                                           | Election resolves within 1–2 cycles            |
| 7 | **Gateway cannot reach leader**       | Gateway retries (timeout ≥ 2 s) → polls all replicas at `/status` → discovers new leader → replays queued strokes                 | Strokes delivered once leader found            |
| 8 | **Client WebSocket disconnects**      | Client reconnects → Gateway sends `full-sync` message with all committed strokes → client re-renders canvas                      | Client sees complete canvas on reconnect       |
| 9 | **Simultaneous rapid restarts**       | Randomised election timeouts prevent repeated split votes → system stabilises after each cycle                                     | Eventually consistent; leader elected          |
| 10 | **Network partition** *(bonus)*       | Minority partition cannot commit (no quorum) → majority partition elects leader and continues serving clients                     | Majority partition stays live; minority paused |

---

## 5. Week-Wise Execution Plan

### Week 1 — Design & Architecture (Days 1–7)

**Goal:** All design decisions finalised, boilerplate code in place, all containers start without errors.

| Day   | Task                                                                       | Owner    | Deliverable                              |
| ----- | -------------------------------------------------------------------------- | -------- | ---------------------------------------- |
| 1     | Read RAFT paper + project requirements; align as a team                    | All      | Shared understanding notes               |
| 1–2   | Design system architecture diagram (cluster layout, communication flows)   | Member A | Architecture diagram (draw.io / Mermaid) |
| 2–3   | Define all API contracts — RPC + WebSocket message formats                 | Member B | API spec (from SRS_Document.md §6)       |
| 3–4   | Design RAFT state machine — state transitions, timing constants, pseudocode | Member C | State machine diagram + pseudocode       |
| 4–5   | Write `docker-compose.yml` + all Dockerfiles                               | Member D | Working `docker-compose up` (no logic)  |
| 5–6   | Set up monorepo structure; scaffold all services with stub endpoints        | All      | Repo with 4 services that build and start |
| 6     | List all failure scenarios and define expected behaviors                   | All      | Failure scenarios table (§4 above)       |
| 7     | **Week 1 Review** — run `docker-compose up --build`, verify all 5 containers start | All | All containers healthy             |

**Week 1 Acceptance Criteria:**
- [x] Architecture diagram complete (`documentation/architecture_diagram.md`)
- [ ] All API endpoints documented and agreed
- [ ] RAFT state machine design documented
- [ ] `docker-compose up` starts all 5 services without errors
- [ ] Failure scenarios table complete
- [ ] Stub `/status` endpoint returns valid JSON on all replicas

---

### Week 2 — Core Implementation (Days 8–14)

**Goal:** End-to-end stroke flow works. Drawing in one tab appears in another tab. Leader election is functional.

| Day   | Task                                                                                 | Owner           | Deliverable                               |
| ----- | ------------------------------------------------------------------------------------ | --------------- | ----------------------------------------- |
| 8–9   | Implement RAFT state machine skeleton — Follower / Candidate / Leader state transitions | Member A + C | `raft.js` with working state transitions  |
| 8–9   | Implement WebSocket Gateway — accept connections, manage client list                 | Member B        | Gateway accepts WS clients                |
| 8–9   | Implement Frontend canvas — freehand drawing + WS client                            | Member D        | Canvas captures and sends strokes         |
| 10–11 | Implement Leader Election — `/request-vote`, `/heartbeat`, election timeout          | Member A + C    | One replica becomes leader on startup     |
| 10–11 | Implement Gateway leader tracking — `/status` polling + stroke forwarding            | Member B        | Gateway forwards strokes to leader        |
| 12–13 | Implement Log Replication — `/append-entries`, majority ACK, commit logic           | Member A + C    | Strokes replicated to followers           |
| 12–13 | Integrate Frontend ↔ Gateway ↔ Leader stroke pipeline                               | Member B + D    | Draw in one tab → appears in another      |
| 14    | **Week 2 Review** — full integration test with 2 browser tabs                       | All             | End-to-end drawing works                  |

**Week 2 Acceptance Criteria:**
- [x] Leader election works — kill leader → new election → new leader within 2 s
- [x] Strokes replicated to majority before commit (`handleClientStroke` majority-ACK pipeline)
- [x] End-to-end: draw in Tab A → appears in Tab B (Gateway `/broadcast` → WebSocket push)
- [x] Gateway correctly re-routes on leader change (leaderTracker discovery + stroke queue replay)
- [x] All election/commit events visible in `docker logs`

> ✅ **Week 2 Complete** — All 5 containers run, `replica1` elected Leader in Term 1 on startup.
> Full implementation details: [`Week2_Implementation_Progress.md`](./Week2_Implementation_Progress.md)

---

### Week 3 — Reliability & Zero-Downtime (Days 15–21)

**Goal:** System survives chaos. Hot-reload works. Multi-client sync works. Demo video recorded.

| Day   | Task                                                                                 | Owner        | Deliverable                                  |
| ----- | ------------------------------------------------------------------------------------ | ------------ | -------------------------------------------- |
| 15–16 | Implement `/sync-log` catch-up protocol for restarted nodes                          | Member A + C | Restarted replica catches up automatically   |
| 15–16 | Wire up bind mounts + nodemon hot-reload in all replica containers                   | Member D     | Edit file → container restarts → rejoins     |
| 17–18 | Implement graceful failover in Gateway — stroke queuing during leader transition      | Member B     | No client disconnects during failover        |
| 17–18 | Implement reconnection + full-sync on Frontend                                       | Member D     | Reconnected client sees complete canvas      |
| 19    | **Chaos testing** — rapid failures, multiple restarts, concurrent multi-client draws | All          | System survives all chaos scenarios          |
| 20    | Bug fixes, observability logs polish, UI polish                                      | All          | Stable and observable system                 |
| 21    | **Record demo video** (8–10 minutes covering all scenarios)                          | All          | Submitted video                              |

**Week 3 Acceptance Criteria:**
- [ ] Hot-reload any replica → system stays live, canvas consistent
- [ ] Kill leader → automatic failover → clients unaffected
- [ ] Restarted replica catches up via `/sync-log`
- [ ] Multi-client real-time sync verified across 3+ browser tabs
- [ ] System stable under chaotic conditions (rapid kills, restarts, concurrent clients)
- [ ] Demo video recorded covering all 5 required scenarios

---

### Team Responsibility Summary

| Member   | Primary Area                                       | Secondary Area                        |
| -------- | -------------------------------------------------- | ------------------------------------- |
| Member A | RAFT state machine (raft.js, log.js)               | Catch-up protocol, election logic     |
| Member B | Gateway (WS server, leader tracker, failover)      | API integration, stroke routing       |
| Member C | RAFT state machine (election, AppendEntries)        | Testing, chaos scenarios              |
| Member D | Frontend (canvas, WS client), Docker infra          | Hot-reload, reconnection, UI polish   |

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Component    | What to Test                                                        |
| ------------ | ------------------------------------------------------------------- |
| `raft.js`    | State transitions, term increment, vote granting logic              |
| `log.js`     | Append entry, commit, prevLogIndex check, sync-log merge            |
| Gateway      | Leader tracking, client list management, stroke broadcast           |

### 6.2 Integration Tests

| Test Case                                | Steps                                                               | Expected Result                         |
| ---------------------------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| Leader election on startup               | Start all 3 replicas → poll `/status` on each                       | Exactly one returns `"state": "Leader"` |
| Leader election after failure            | `docker-compose stop replica1` → wait 2 s → poll `/status`         | Another replica becomes leader          |
| Stroke replication                       | POST stroke to leader → poll `/status` on all 3                     | All 3 have matching `logLength`         |
| End-to-end drawing                       | Open 2 browser tabs → draw in Tab A → check Tab B                   | Stroke appears in Tab B within 200 ms   |
| Catch-up on restart                      | Stop a follower → draw 5 strokes → restart follower → poll `/status` | `logLength` matches leader              |

### 6.3 Chaos Tests

| Test Case                                | Method                                              | Pass Condition                                         |
| ---------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| Kill leader during active drawing        | `docker stop <leader>` while drawing continuously   | New leader elected; no stroke lost                     |
| Hot-reload follower during replication   | Edit `replica2/raft.js` while strokes in-flight     | Follower restarts and catches up; canvas consistent    |
| Rapid leader restarts (3× in 10 s)       | `docker restart <leader>` 3 times quickly           | System stabilises; canvas intact                       |
| Sequential restart of all replicas       | Restart replica1 → replica2 → replica3, one by one  | Canvas state preserved throughout                      |
| 10 concurrent browser tabs drawing       | Open 10 tabs, all draw simultaneously               | All canvases identical; no ordering errors             |

### 6.4 Manual Verification Checklist

- [ ] Draw in Tab A → appears in Tab B within 200 ms
- [ ] `docker stop <leader>` → drawing resumes within 2 s in all tabs
- [ ] Edit `replica1/server.js` (add a comment) → container restarts → no client disconnect
- [ ] Restart all replicas one by one → canvas state preserved at each step
- [ ] Open 5+ tabs → all draw simultaneously → all canvases match at the end
- [ ] `docker logs replica1` shows election events, term changes, and commit logs

---

## 7. Submission Deliverables

### A. Source Code Repository

```
/gateway                          # Gateway microservice
/replica1, /replica2, /replica3   # Replica RAFT nodes (same codebase)
/frontend                         # Browser canvas application
/documentation                    # SRS_Document.md + Implementation_Plan.md
docker-compose.yml                # Full orchestration
README.md                         # Setup + run instructions
```

**README.md must include:**
- Prerequisites (Docker, Docker Compose)
- How to start: `docker-compose up --build`
- How to simulate failures: `docker-compose stop replica1`
- How to trigger hot-reload: edit any file in `replica1/`
- How to view logs: `docker logs -f replica1`

### B. Architecture Document (2–3 pages)

- Cluster diagram showing all 4 microservices and communication flows
- Mini-RAFT protocol design summary
- State transition diagram (Follower → Candidate → Leader)
- API endpoint definitions
- Failure-handling design decisions

### C. Demonstration Video (8–10 minutes)

Must demonstrate:
1. **Multi-user drawing** — drawing from 3+ browser tabs simultaneously
2. **Leader failover** — `docker stop <leader>` → automatic election → drawing resumes
3. **Hot-reload** — edit a source file → container restarts → system stays live, canvas consistent
4. **Catch-up sync** — show `docker logs` confirming `/sync-log` called on restarted node
5. **Chaos conditions** — multiple rapid failures, simultaneous client connections, stress test

---

## 8. Bonus Challenges (Optional)

| Bonus                  | Description                                                                   | Estimated Effort |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------- |
| Network Partitions     | Simulate split-brain via `iptables` rules; verify correct RAFT behavior       | High             |
| 4th Replica            | Add `replica4` to `docker-compose.yml`; adjust quorum to ≥ 3 out of 4        | Medium           |
| Undo / Redo            | Implement undo as a compensating log entry; redo replays from log             | High             |
| Admin Dashboard        | Real-time UI showing leader ID, term, log sizes, and state for each replica  | Medium           |
| Cloud Deployment       | Deploy all containers to AWS EC2 or Google Cloud VM via Docker Compose        | High             |

---

*End of Implementation Plan — v1.0*
