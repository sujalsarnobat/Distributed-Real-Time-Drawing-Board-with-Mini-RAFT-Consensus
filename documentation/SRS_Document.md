# Software Requirements Specification (SRS)

## Distributed Real-Time Drawing Board with Mini-RAFT Consensus

| Field             | Detail                                                       |
| ----------------- | ------------------------------------------------------------ |
| **Project Title** | Distributed Real-Time Drawing Board with Mini-RAFT Consensus |
| **Version**       | 1.0                                                          |
| **Date**          | April 2026                                                   |
| **Team Size**     | 4 Members                                                    |
| **Duration**      | 3 Weeks                                                      |
| **Architecture**  | Microservices (Containerised via Docker)                     |

> **Related Document:** See `Implementation_Plan.md` for the week-wise execution plan, Docker deployment specs, testing strategy, and failure scenario handling.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Overall Description](#2-overall-description)
3. [System Architecture — Microservices](#3-system-architecture--microservices)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [API Specification](#6-api-specification)
7. [Mini-RAFT Consensus Protocol Specification](#7-mini-raft-consensus-protocol-specification)
8. [Data Models & Log Schema](#8-data-models--log-schema)
9. [Glossary](#9-glossary)

---

## 1. Introduction

### 1.1 Purpose

This document provides the Software Requirements Specification for the **Distributed Real-Time Drawing Board** project. It defines all functional and non-functional requirements, describes the microservices architecture, specifies the Mini-RAFT consensus protocol, details API contracts, and formalises data models.

### 1.2 Scope

The system is a real-time collaborative whiteboard where multiple users draw on a shared browser canvas. Drawing strokes propagate instantly to all connected clients. The backend is a **cluster of three replica nodes** that maintain a shared append-only stroke log through a simplified RAFT consensus protocol. A fourth service — the **Gateway** — manages WebSocket client connections and routes traffic to the current leader.

The system must tolerate replica failures, support hot-reload via bind-mounted volumes, perform automatic leader election, and maintain zero-downtime availability.

### 1.3 Intended Audience

- Development team members
- Project evaluators / faculty
- DevOps engineers reviewing deployment strategy

### 1.4 Definitions & Acronyms

| Term          | Definition                                                                |
| ------------- | ------------------------------------------------------------------------- |
| RAFT          | Consensus algorithm for managing a replicated log                         |
| RPC           | Remote Procedure Call                                                     |
| WebSocket     | Full-duplex communication protocol over a single TCP connection           |
| Leader        | The replica responsible for accepting writes and replicating to followers |
| Follower      | A replica that passively replicates the leader's log                      |
| Candidate     | A replica that has initiated an election to become leader                 |
| Term          | A monotonically increasing logical clock used in RAFT elections           |
| Commit Index  | The highest log entry index known to be replicated on a majority of nodes |
| Quorum        | Minimum number of nodes required for consensus (2 out of 3)              |
| Hot-Reload    | Automatic restart of a container when source files change                 |
| Bind Mount    | Docker volume that maps a host directory into a container                 |

### 1.5 References

- Diego Ongaro & John Ousterhout, *"In Search of an Understandable Consensus Algorithm (RAFT)"*, 2014
- Docker Documentation: https://docs.docker.com
- WebSocket Protocol (RFC 6455)

---

## 2. Overall Description

### 2.1 Product Perspective

This project simulates core distributed systems concepts found in production cloud infrastructure:

| Real-World System          | Concept Simulated                                 |
| -------------------------- | ------------------------------------------------- |
| Kubernetes Control Plane   | Leader election + consensus via etcd (RAFT)       |
| CockroachDB                | Log replication across database nodes             |
| Figma / Miro / Google Docs | Real-time collaborative editing via event streams |
| AWS / GCP Rolling Deploys  | Zero-downtime container hot-reload                |

### 2.2 Product Functions (High-Level)

1. **Real-time collaborative drawing** on a shared canvas via WebSockets
2. **Mini-RAFT consensus** for stroke log replication across 3 replica nodes
3. **Automatic leader election** with term-based voting
4. **Fault tolerance** — any replica can crash/restart without data loss or client disruption
5. **Zero-downtime hot-reload** — editing source files triggers container restart with seamless failover
6. **Catch-up synchronization** — restarted nodes sync missed log entries from the leader

### 2.3 User Classes

| User Class              | Description                                        |
| ----------------------- | -------------------------------------------------- |
| **End User (Drawer)**   | Opens the canvas in a browser tab and draws        |
| **Administrator / Dev** | Manages Docker containers, triggers hot-reloads    |

### 2.4 Operating Environment

- **Host OS**: Linux / macOS / Windows (with Docker Desktop)
- **Runtime**: Docker Engine + Docker Compose
- **Browser**: Any modern browser (Chrome, Firefox, Edge, Safari)
- **Languages**: Node.js (JavaScript/TypeScript) or Go (team choice)

### 2.5 Constraints

- Exactly **3 replica nodes** (no dynamic scaling unless bonus)
- Simplified RAFT — no log compaction, no snapshotting
- Single Gateway instance (no Gateway HA unless bonus)
- No persistent disk storage — logs are in-memory (lost on full cluster restart)

---

## 3. System Architecture — Microservices

### 3.1 Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        DOCKER NETWORK (raft-net)                     │
│                                                                      │
│  ┌─────────────┐       ┌──────────────────────────────────────────┐  │
│  │             │       │          RAFT CLUSTER                    │  │
│  │  FRONTEND   │  WS   │  ┌───────────┐                          │  │
│  │  (Browser)  │◄─────►│  │  GATEWAY  │                          │  │
│  │             │       │  │  :3000    │                          │  │
│  └─────────────┘       │  └─────┬─────┘                          │  │
│                        │        │ HTTP (stroke forwarding)        │  │
│                        │        ▼                                 │  │
│                        │  ┌───────────┐  RPC   ┌───────────┐     │  │
│                        │  │ REPLICA 1 │◄──────►│ REPLICA 2 │     │  │
│                        │  │  :4001    │        │  :4002    │     │  │
│                        │  └─────┬─────┘        └─────┬─────┘     │  │
│                        │        │    RPC              │           │  │
│                        │        └──────►┌───────────┐◄┘           │  │
│                        │               │ REPLICA 3 │             │  │
│                        │               │  :4003    │             │  │
│                        │               └───────────┘             │  │
│                        └──────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 Microservice Breakdown

The system is decomposed into **4 independently deployable microservices**, each running in its own Docker container.

---

#### Microservice 1: Frontend

| Property          | Value                                                |
| ----------------- | ---------------------------------------------------- |
| **Type**          | Static SPA (Single Page Application)                 |
| **Container**     | `frontend`                                           |
| **Port**          | `8080`                                               |
| **Technology**    | HTML5 Canvas + Vanilla JavaScript + CSS              |
| **Communication** | WebSocket connection to Gateway                      |

**Responsibilities:**
- Render an HTML5 `<canvas>` element for drawing
- Capture mouse/touch events and emit stroke data via WebSocket
- Receive committed stroke events from the Gateway and render them
- Handle WebSocket reconnection gracefully on connection loss
- Display connection status indicator

**Directory Structure:**
```
frontend/
├── index.html        # Main HTML page with canvas
├── style.css         # Styles
├── app.js            # WebSocket client + canvas drawing logic
├── Dockerfile
└── package.json
```

---

#### Microservice 2: Gateway Service

| Property          | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| **Type**          | WebSocket Proxy / Router                                       |
| **Container**     | `gateway`                                                      |
| **Port**          | `3000`                                                         |
| **Technology**    | Node.js with `ws` library (or Go with `gorilla/websocket`)     |
| **Communication** | WebSocket ↔ Clients; HTTP ↔ Replicas                          |

**Responsibilities:**
- Accept and manage WebSocket connections from browser clients
- Maintain a pointer to the **current RAFT leader**
- Forward incoming stroke data from clients to the leader via HTTP POST to `/client-stroke`
- Receive committed stroke broadcasts from the leader via `/broadcast` and relay to all clients
- Detect leader failures and discover the new leader by polling `/status` on all replicas
- **Never disconnect clients** during leader transitions
- Expose a health-check endpoint

**Leader Discovery Mechanism:**
1. On startup, Gateway polls all 3 replicas at `/status` to find the leader
2. On leader failure (HTTP error / timeout), Gateway retries all replicas to find the new leader
3. The leader can also push leader-change notifications to the Gateway

**Directory Structure:**
```
gateway/
├── server.js           # WebSocket + HTTP routing
├── leaderTracker.js    # Discover and track the current leader
├── Dockerfile
├── package.json
└── nodemon.json
```

---

#### Microservice 3: Replica Nodes (×3)

| Property          | Value                                              |
| ----------------- | -------------------------------------------------- |
| **Type**          | RAFT Consensus Node                                |
| **Containers**    | `replica1`, `replica2`, `replica3`                 |
| **Ports**         | `4001`, `4002`, `4003`                             |
| **Technology**    | Node.js (Express) or Go (net/http)                 |
| **Communication** | HTTP RPC between replicas; HTTP with Gateway       |

**Responsibilities:**
- Implement the **Mini-RAFT state machine** (Follower → Candidate → Leader)
- Maintain an **in-memory append-only stroke log**
- Participate in **leader elections** via `RequestVote` RPC
- **Leader**: accept strokes, replicate via `AppendEntries`, commit on majority ACK
- **Follower**: respond to `AppendEntries`, respond to `RequestVote`, enforce election timeout
- **Candidate**: increment term, request votes, transition on win/loss/timeout
- Expose RPC endpoints: `/request-vote`, `/append-entries`, `/heartbeat`, `/sync-log`, `/status`
- Handle **catch-up synchronization** for restarted nodes
- Log all election events, term changes, and commits to stdout

> **Note:** All three replicas run the **same codebase**. The only difference is the `REPLICA_ID` and `PEERS` environment variables injected via `docker-compose.yml`.

**Directory Structure:**
```
replica1/               # replica2/ and replica3/ have identical structure
├── server.js           # HTTP server exposing RPC endpoints
├── raft.js             # RAFT state machine
├── log.js              # Append-only stroke log management
├── config.js           # Replica ID, peer addresses, timing constants
├── Dockerfile
├── package.json
└── nodemon.json
```

---

#### Microservice 4: Shared Bind-Mounted Volumes

| Property      | Value                                                     |
| ------------- | --------------------------------------------------------- |
| **Type**      | Infrastructure concern (not a standalone microservice)    |
| **Mechanism** | Docker bind mounts                                        |
| **Purpose**   | Enable hot-reload of replica source code without manual restart |

**How It Works:**
1. Each replica container bind-mounts its source folder from the host
2. Inside the container, `nodemon` (Node.js) or `air` (Go) watches for file changes
3. A change to any file in `replica1/` causes the container to automatically restart
4. The restarted replica starts as a **Follower** with an empty log
5. On first `AppendEntries` from the leader, the `prevLogIndex` check fails → triggers catch-up protocol
6. After syncing, the replica participates normally in the cluster
7. If the restarted node was the **leader**, remaining replicas detect missed heartbeats and elect a new leader

**Key Requirement:** During the entire hot-reload cycle the system must remain available to clients — **zero downtime**.

---

### 3.3 Service Communication Matrix

| From      | To        | Protocol  | Pattern          | Purpose                                       |
| --------- | --------- | --------- | ---------------- | --------------------------------------------- |
| Frontend  | Gateway   | WebSocket | Bidirectional    | Send strokes, receive committed strokes        |
| Gateway   | Leader    | HTTP POST | Request/Response | Forward client strokes                        |
| Leader    | Gateway   | HTTP POST | Push             | Broadcast committed strokes                   |
| Leader    | Followers | HTTP POST | RPC              | AppendEntries (log replication)               |
| Leader    | Followers | HTTP POST | RPC              | Heartbeat (liveness)                          |
| Candidate | All Peers | HTTP POST | RPC              | RequestVote (election)                        |
| Follower  | Leader    | HTTP POST | RPC              | SyncLog (catch-up)                            |
| Any Node  | Gateway   | HTTP GET  | Request/Response | Report status / leader identity               |

### 3.4 Service Discovery

All services discover each other via **Docker Compose DNS** on the shared `raft-net` network:

| Service    | DNS Hostname | Port |
| ---------- | ------------ | ---- |
| Gateway    | `gateway`    | 3000 |
| Replica 1  | `replica1`   | 4001 |
| Replica 2  | `replica2`   | 4002 |
| Replica 3  | `replica3`   | 4003 |
| Frontend   | `frontend`   | 8080 |

---

## 4. Functional Requirements

### 4.1 Frontend (FR-FE)

| ID       | Requirement                                                                                               | Priority |
| -------- | --------------------------------------------------------------------------------------------------------- | -------- |
| FR-FE-01 | The system SHALL render an HTML5 `<canvas>` element that fills the viewport                               | Must     |
| FR-FE-02 | Users SHALL be able to draw freehand lines using mouse click-and-drag                                     | Must     |
| FR-FE-03 | Users SHALL be able to draw freehand lines using touch input on mobile/tablet                             | Should   |
| FR-FE-04 | Each stroke SHALL be captured as a series of `(x, y)` coordinate points with a color and width           | Must     |
| FR-FE-05 | The frontend SHALL send stroke data to the Gateway via WebSocket in JSON format                           | Must     |
| FR-FE-06 | The frontend SHALL receive committed stroke events from the Gateway and render them on canvas              | Must     |
| FR-FE-07 | The frontend SHALL render remote strokes without flickering or lag                                        | Must     |
| FR-FE-08 | The frontend SHALL display a connection status indicator (connected / reconnecting / disconnected)         | Should   |
| FR-FE-09 | The frontend SHALL attempt automatic WebSocket reconnection on connection loss (exponential backoff)       | Must     |
| FR-FE-10 | On reconnection, the frontend SHALL request full canvas state to re-render all committed strokes          | Must     |

---

### 4.2 Gateway Service (FR-GW)

| ID       | Requirement                                                                                               | Priority |
| -------- | --------------------------------------------------------------------------------------------------------- | -------- |
| FR-GW-01 | The Gateway SHALL accept WebSocket connections from multiple browser clients simultaneously                | Must     |
| FR-GW-02 | The Gateway SHALL maintain a list of all active WebSocket connections                                     | Must     |
| FR-GW-03 | The Gateway SHALL track the identity (host + port) of the current RAFT leader                             | Must     |
| FR-GW-04 | The Gateway SHALL forward incoming stroke data from any client to the leader via `POST /client-stroke`    | Must     |
| FR-GW-05 | The Gateway SHALL receive committed strokes from the leader via `POST /broadcast`                         | Must     |
| FR-GW-06 | On receiving a committed stroke, the Gateway SHALL broadcast it to ALL connected WebSocket clients        | Must     |
| FR-GW-07 | If the leader becomes unreachable (HTTP timeout ≥ 2 s), the Gateway SHALL poll all replicas at `/status` to discover the new leader | Must |
| FR-GW-08 | During leader failover, the Gateway SHALL queue incoming client strokes and replay them once a new leader is found | Should |
| FR-GW-09 | The Gateway SHALL NOT disconnect any client WebSocket connections during leader transitions                | Must     |
| FR-GW-10 | The Gateway SHALL expose `GET /health` returning `{ "status": "ok", "leader": "<id>" }`                  | Should   |

---

### 4.3 Replica Nodes — RAFT Consensus (FR-RF)

#### 4.3.1 State Management

| ID       | Requirement                                                                                               | Priority |
| -------- | --------------------------------------------------------------------------------------------------------- | -------- |
| FR-RF-01 | Each replica SHALL maintain its current state: `Follower`, `Candidate`, or `Leader`                       | Must     |
| FR-RF-02 | Each replica SHALL maintain a monotonically increasing `currentTerm` (starting at 0)                      | Must     |
| FR-RF-03 | Each replica SHALL maintain a `votedFor` field (reset to `null` on term change)                           | Must     |
| FR-RF-04 | Each replica SHALL maintain an in-memory append-only stroke log (array of log entries)                    | Must     |
| FR-RF-05 | Each replica SHALL maintain a `commitIndex` (highest log index committed)                                 | Must     |
| FR-RF-06 | Each replica SHALL start in `Follower` state on boot                                                      | Must     |
| FR-RF-07 | Each replica SHALL expose `GET /status` returning `{ id, state, term, leader, logLength, commitIndex }`   | Must     |

#### 4.3.2 Leader Election

| ID       | Requirement                                                                                               | Priority |
| -------- | --------------------------------------------------------------------------------------------------------- | -------- |
| FR-RF-10 | A Follower SHALL start a randomised election timeout between **500 ms and 800 ms**                        | Must     |
| FR-RF-11 | If a Follower does not receive a heartbeat within its election timeout, it SHALL transition to `Candidate` | Must     |
| FR-RF-12 | A Candidate SHALL increment its `currentTerm` by 1                                                        | Must     |
| FR-RF-13 | A Candidate SHALL vote for itself and set `votedFor = self`                                               | Must     |
| FR-RF-14 | A Candidate SHALL send `RequestVote` RPCs to all peer replicas in parallel                                | Must     |
| FR-RF-15 | A Candidate SHALL become `Leader` upon receiving votes from a **majority (≥ 2 out of 3)**                 | Must     |
| FR-RF-16 | A Candidate SHALL revert to `Follower` if it receives an AppendEntries / heartbeat with term ≥ its own   | Must     |
| FR-RF-17 | If no majority is reached within the election timeout, the Candidate SHALL start a new election            | Must     |
| FR-RF-18 | A node SHALL grant a vote only if `votedFor` is null (or already this candidate) AND candidate's term ≥ own term | Must |
| FR-RF-19 | If a node receives any RPC with a higher term, it SHALL update its term and revert to `Follower`          | Must     |

#### 4.3.3 Heartbeat

| ID       | Requirement                                                                                               | Priority |
| -------- | --------------------------------------------------------------------------------------------------------- | -------- |
| FR-RF-20 | The Leader SHALL send heartbeat RPCs to all followers every **150 ms**                                    | Must     |
| FR-RF-21 | Heartbeat messages SHALL include `{ term, leaderId }`                                                     | Must     |
| FR-RF-22 | On receiving a valid heartbeat, a Follower SHALL reset its election timeout                               | Must     |
| FR-RF-23 | If a Follower receives a heartbeat with a lower term, it SHALL reject it                                  | Must     |

#### 4.3.4 Log Replication

| ID       | Requirement                                                                                               | Priority |
| -------- | --------------------------------------------------------------------------------------------------------- | -------- |
| FR-RF-30 | The Leader SHALL accept stroke data from the Gateway via `POST /client-stroke`                            | Must     |
| FR-RF-31 | On receiving a stroke, the Leader SHALL append it to its local log with the current term and next index   | Must     |
| FR-RF-32 | The Leader SHALL send `AppendEntries` RPCs to all followers containing the new entry                      | Must     |
| FR-RF-33 | `AppendEntries` SHALL include: `{ term, leaderId, prevLogIndex, prevLogTerm, entry, leaderCommit }`       | Must     |
| FR-RF-34 | A Follower SHALL append the entry if `prevLogIndex` and `prevLogTerm` match its log                       | Must     |
| FR-RF-35 | A Follower SHALL reject `AppendEntries` if the consistency check fails and respond with its current log length | Must |
| FR-RF-36 | When the Leader receives successful responses from a **majority**, it SHALL mark the entry as **committed** | Must    |
| FR-RF-37 | After committing, the Leader SHALL notify the Gateway via `POST /broadcast` with the committed stroke     | Must     |
| FR-RF-38 | Committed entries SHALL **never** be overwritten or deleted                                               | Must     |
| FR-RF-39 | A higher term SHALL always take precedence over a lower term                                              | Must     |

#### 4.3.5 Catch-Up Synchronization (Restarted Nodes)

| ID       | Requirement                                                                                               | Priority |
| -------- | --------------------------------------------------------------------------------------------------------- | -------- |
| FR-RF-40 | A restarted node SHALL start in `Follower` state with an empty log                                        | Must     |
| FR-RF-41 | On first `AppendEntries` from the leader, the `prevLogIndex` check SHALL fail for a restarted node        | Must     |
| FR-RF-42 | The Follower SHALL respond with `{ success: false, logLength: <current length> }`                         | Must     |
| FR-RF-43 | The Leader SHALL call `POST /sync-log` on the Follower, sending all committed entries from the Follower's reported index onward | Must |
| FR-RF-44 | The Follower SHALL append all received entries and update its `commitIndex`                                | Must     |
| FR-RF-45 | After sync, the Follower SHALL participate normally in future `AppendEntries` and elections               | Must     |

---

### 4.4 Shared Bind-Mounted Volumes (FR-HV)

| ID       | Requirement                                                                                               | Priority |
| -------- | --------------------------------------------------------------------------------------------------------- | -------- |
| FR-HV-01 | Each replica container SHALL bind-mount its source directory from the host filesystem                     | Must     |
| FR-HV-02 | A file watcher (nodemon / air) inside the container SHALL detect file changes and restart the process     | Must     |
| FR-HV-03 | On restart, the replica SHALL go through normal RAFT startup (Follower → catch-up)                        | Must     |
| FR-HV-04 | If the restarted replica was the Leader, the remaining replicas SHALL detect missed heartbeats and elect a new Leader | Must |
| FR-HV-05 | The Gateway SHALL detect the leader change and re-route traffic to the new Leader                         | Must     |
| FR-HV-06 | Clients SHALL NOT be disconnected or experience visible disruption during the hot-reload cycle            | Must     |

---

## 5. Non-Functional Requirements

### 5.1 Performance

| ID        | Requirement                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| NFR-P-01  | Stroke-to-render latency SHALL be ≤ **200 ms** under normal conditions (no failover)              |
| NFR-P-02  | Leader election SHALL complete within **2 seconds** of leader failure detection                    |
| NFR-P-03  | Heartbeat interval SHALL be **150 ms**                                                            |
| NFR-P-04  | Election timeout SHALL be randomised between **500 ms and 800 ms**                                |
| NFR-P-05  | The system SHALL support at least **10 concurrent WebSocket clients** without degradation          |

### 5.2 Availability

| ID        | Requirement                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| NFR-A-01  | The system SHALL remain available as long as a **majority of replicas (≥ 2)** are running         |
| NFR-A-02  | The Gateway SHALL remain available at all times                                                   |
| NFR-A-03  | Zero-downtime SHALL be maintained during single-replica hot-reloads                               |

### 5.3 Consistency

| ID        | Requirement                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| NFR-C-01  | All connected clients SHALL see an **identical final canvas state**                                |
| NFR-C-02  | Stroke ordering SHALL be consistent across all replicas (determined by log index)                 |
| NFR-C-03  | Committed entries SHALL never be lost or reordered                                                |

### 5.4 Fault Tolerance

| ID        | Requirement                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| NFR-F-01  | The system SHALL tolerate the failure of **1 out of 3** replicas without data loss                |
| NFR-F-02  | A failed replica SHALL automatically catch up on restart via the sync-log protocol               |
| NFR-F-03  | Split votes SHALL be resolved by re-election with a new random timeout                           |

### 5.5 Scalability

| ID        | Requirement                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| NFR-S-01  | The architecture SHALL allow adding a 4th replica without breaking correctness (bonus)            |
| NFR-S-02  | Adding more clients SHALL not require changes to the backend cluster                              |

### 5.6 Observability

| ID        | Requirement                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| NFR-O-01  | Each replica SHALL log state transitions (Follower → Candidate → Leader) to stdout               |
| NFR-O-02  | Each replica SHALL log election events (vote requests sent/received, term changes)                |
| NFR-O-03  | Each replica SHALL log commit events (entry index, term, stroke summary)                         |
| NFR-O-04  | Logs SHALL be viewable via `docker logs <container>`                                              |
| NFR-O-05  | Each replica SHALL log heartbeat events at debug level                                            |

### 5.7 Security

| ID        | Requirement                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| NFR-SE-01 | All inter-replica communication SHALL occur within the Docker network (not exposed to host)      |
| NFR-SE-02 | Only the Gateway and Frontend ports SHALL be exposed to the host                                  |

### 5.8 Maintainability

| ID        | Requirement                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| NFR-M-01  | All three replicas SHALL share the same codebase, differentiated only by environment variables    |
| NFR-M-02  | Configuration (peer addresses, ports, timeouts) SHALL be externalised via environment variables   |
| NFR-M-03  | The project SHALL use a monorepo structure with clear directory separation per microservice       |

---

## 6. API Specification

### 6.1 Replica RPC Endpoints

All replica-to-replica communication uses **HTTP POST** with JSON bodies.

---

#### `POST /request-vote`

**Purpose:** Called by a Candidate to request a vote from a peer.

**Request:**
```json
{
  "term": 3,
  "candidateId": "replica1",
  "lastLogIndex": 5,
  "lastLogTerm": 2
}
```

**Response:**
```json
{
  "term": 3,
  "voteGranted": true
}
```

**Rules:**
- Grant vote if `term >= currentTerm` AND (`votedFor` is null or already this candidate)
- Reject if `term < currentTerm`
- If `term > currentTerm`, update own term and revert to Follower before deciding

---

#### `POST /append-entries`

**Purpose:** Called by the Leader to replicate a log entry to a Follower.

**Request:**
```json
{
  "term": 3,
  "leaderId": "replica1",
  "prevLogIndex": 4,
  "prevLogTerm": 2,
  "entry": {
    "index": 5,
    "term": 3,
    "stroke": {
      "points": [{"x": 10, "y": 20}, {"x": 15, "y": 25}],
      "color": "#FF0000",
      "width": 3
    }
  },
  "leaderCommit": 4
}
```

**Response (success):**
```json
{
  "term": 3,
  "success": true
}
```

**Response (log mismatch):**
```json
{
  "term": 3,
  "success": false,
  "logLength": 2
}
```

---

#### `POST /heartbeat`

**Purpose:** Leader asserts authority and resets followers' election timers.

**Request:**
```json
{
  "term": 3,
  "leaderId": "replica1",
  "leaderCommit": 5
}
```

**Response:**
```json
{
  "term": 3,
  "success": true
}
```

---

#### `POST /sync-log`

**Purpose:** Called by the Leader on a Follower that needs to catch up after restart.

**Request:**
```json
{
  "term": 3,
  "leaderId": "replica1",
  "entries": [
    { "index": 1, "term": 1, "stroke": { "points": [...], "color": "#000", "width": 2 } },
    { "index": 2, "term": 1, "stroke": { "points": [...], "color": "#00F", "width": 3 } }
  ],
  "leaderCommit": 2
}
```

**Response:**
```json
{
  "success": true,
  "logLength": 2
}
```

---

#### `GET /status`

**Purpose:** Query a replica's current RAFT state (used by Gateway and for debugging).

**Response:**
```json
{
  "id": "replica1",
  "state": "Leader",
  "term": 3,
  "leader": "replica1",
  "logLength": 5,
  "commitIndex": 5
}
```

---

### 6.2 Gateway ↔ Leader Endpoints

#### `POST /client-stroke` (on Leader)

**Purpose:** Gateway forwards a client's stroke to the Leader for replication.

**Request:**
```json
{
  "stroke": {
    "points": [{"x": 10, "y": 20}, {"x": 15, "y": 25}],
    "color": "#FF0000",
    "width": 3,
    "userId": "user-abc-123"
  }
}
```

**Response:**
```json
{
  "success": true,
  "index": 6
}
```

---

#### `POST /broadcast` (on Gateway)

**Purpose:** Leader pushes a committed stroke to the Gateway for client broadcast.

**Request:**
```json
{
  "stroke": {
    "index": 6,
    "points": [{"x": 10, "y": 20}, {"x": 15, "y": 25}],
    "color": "#FF0000",
    "width": 3,
    "userId": "user-abc-123"
  }
}
```

---

### 6.3 WebSocket Messages (Frontend ↔ Gateway)

#### Client → Gateway

```json
{
  "type": "stroke",
  "data": {
    "points": [{"x": 10, "y": 20}, {"x": 15, "y": 25}],
    "color": "#FF0000",
    "width": 3
  }
}
```

#### Gateway → Client (committed stroke)

```json
{
  "type": "stroke-committed",
  "data": {
    "index": 6,
    "points": [{"x": 10, "y": 20}, {"x": 15, "y": 25}],
    "color": "#FF0000",
    "width": 3,
    "userId": "user-abc-123"
  }
}
```

#### Gateway → Client (full canvas state on reconnection)

```json
{
  "type": "full-sync",
  "data": {
    "strokes": [
      { "index": 1, "points": [...], "color": "#000", "width": 2 },
      { "index": 2, "points": [...], "color": "#00F", "width": 3 }
    ]
  }
}
```

---

## 7. Mini-RAFT Consensus Protocol Specification

### 7.1 State Transition Diagram

```
                    ┌─────────────────────┐
                    │                     │
                    ▼                     │
    ┌───────────────────────┐             │
    │       FOLLOWER        │             │
    │  · Waits for heartbeat│             │
    │  · Responds to RPCs   │             │
    └───────────┬───────────┘             │
                │                         │
   Election timeout expires               │
   (no heartbeat received)                │
                │                         │
                ▼                         │
    ┌───────────────────────┐             │
    │      CANDIDATE        │   Discovers leader with higher
    │  · Increments term    │   or equal term
    │  · Votes for self     │─────────────┘
    │  · Sends RequestVote  │
    └───────────┬───────────┘
                │
      Receives majority
      votes (≥ 2 of 3)
                │
                ▼
    ┌───────────────────────┐
    │        LEADER         │ Steps down if receives
    │  · Sends heartbeats   │ RPC with higher term
    │  · Replicates log     │────────────────────────►(back to Follower)
    │  · Commits entries    │
    └───────────────────────┘
```

### 7.2 Timing Constants

| Parameter              | Value    | Notes                                |
| ---------------------- | -------- | ------------------------------------ |
| Heartbeat Interval     | 150 ms   | Leader → all Followers               |
| Election Timeout Min   | 500 ms   | Randomised per election attempt      |
| Election Timeout Max   | 800 ms   | Randomised per election attempt      |
| HTTP RPC Timeout       | 300 ms   | For inter-replica RPCs               |
| Gateway Leader Timeout | 2000 ms  | Before Gateway starts re-discovery   |

### 7.3 Election Algorithm (Pseudocode)

```
function startElection():
    state = CANDIDATE
    currentTerm += 1
    votedFor = self.id
    votesReceived = 1          // self-vote

    for each peer in peers (in parallel):
        response = sendRPC(peer, "/request-vote", {
            term: currentTerm,
            candidateId: self.id,
            lastLogIndex: log.lastIndex(),
            lastLogTerm: log.lastTerm()
        })

        if response.term > currentTerm:
            currentTerm = response.term
            state = FOLLOWER
            votedFor = null
            return

        if response.voteGranted:
            votesReceived += 1

    if votesReceived >= 2:
        becomeLeader()
    else:
        resetElectionTimeout()   // split vote — retry
```

### 7.4 Log Replication Algorithm (Pseudocode)

```
function onClientStroke(stroke):
    if state != LEADER:
        return { error: "not leader" }

    entry = { index: log.length + 1, term: currentTerm, stroke: stroke }
    log.append(entry)
    ackCount = 1               // self

    for each peer in peers (in parallel):
        response = sendRPC(peer, "/append-entries", {
            term: currentTerm,
            leaderId: self.id,
            prevLogIndex: entry.index - 1,
            prevLogTerm: log[entry.index - 2]?.term ?? 0,
            entry: entry,
            leaderCommit: commitIndex
        })

        if response.success:
            ackCount += 1
        else:
            triggerSyncLog(peer, response.logLength)   // follower is behind

    if ackCount >= 2:
        commitIndex = entry.index
        notifyGateway(entry.stroke)
```

### 7.5 Catch-Up Protocol (Sequence Diagram)

```
┌──────────────┐                    ┌──────────┐
│  Restarted   │                    │  Leader  │
│  Follower    │                    │          │
└──────┬───────┘                    └────┬─────┘
       │   (boots: empty log, index=0)   │
       │                                 │
       │◄── AppendEntries(prevLogIndex=5)─┤
       │                                 │
       ├──► { success: false, logLength: 0 } ─►
       │                                 │
       │◄── POST /sync-log(entries 1..5) ─┤
       │                                 │
       │  (appends entries 1..5,         │
       │   sets commitIndex = 5)         │
       │                                 │
       ├──► { success: true, logLength: 5 } ─►
       │                                 │
       │◄── Heartbeat / AppendEntries ───┤
       │   (now in sync, normal ops)     │
       └─────────────────────────────────┘
```

---

## 8. Data Models & Log Schema

### 8.1 Stroke Object

```json
{
  "points": [
    { "x": 120, "y": 300 },
    { "x": 125, "y": 305 },
    { "x": 130, "y": 310 }
  ],
  "color": "#FF5733",
  "width": 3,
  "userId": "user-abc-123",
  "timestamp": 1712000000000
}
```

### 8.2 Log Entry

```json
{
  "index": 1,
  "term": 1,
  "stroke": { "...Stroke Object..." },
  "committed": true
}
```

### 8.3 Replica In-Memory State

```javascript
{
  id: "replica1",              // From REPLICA_ID env var
  state: "Follower",           // Follower | Candidate | Leader
  currentTerm: 0,              // Monotonically increasing integer
  votedFor: null,              // candidateId or null
  log: [],                     // Array of Log Entries
  commitIndex: 0,              // Index of last committed entry
  leader: null,                // Current known leader ID
  peers: [                     // Peer addresses
    "http://replica2:4002",
    "http://replica3:4003"
  ]
}
```

---

## 9. Glossary

| Term                | Definition                                                                              |
| ------------------- | --------------------------------------------------------------------------------------- |
| Append-Only Log     | A data structure where entries are only ever appended, never modified or deleted         |
| Blue-Green Deploy   | A strategy using two identical environments to achieve zero-downtime deployments         |
| Candidate           | A RAFT node state where the node is requesting votes to become leader                    |
| Committed Entry     | A log entry replicated to a majority of nodes and considered durable                    |
| Consensus           | Agreement among distributed nodes on a single data value or sequence of operations      |
| Election Timeout    | Duration a Follower waits before becoming a Candidate                                   |
| Follower            | A RAFT node state where the node passively replicates the leader's log                   |
| Heartbeat           | Periodic message from the Leader to Followers to maintain authority                      |
| Hot-Reload          | Automatic restart of a service when its source files change                              |
| Leader              | The RAFT node responsible for accepting writes and replicating to followers              |
| Log Index           | The position of an entry in the append-only log (1-indexed)                              |
| Majority / Quorum   | Minimum number of nodes needed for a decision (2 out of 3 in this system)               |
| Microservice        | An independently deployable service responsible for a single concern                     |
| Rolling Update      | Deploying changes to one instance at a time to maintain availability                     |
| RPC                 | Remote Procedure Call — a request/response pattern between services                     |
| Split Vote          | An election where no candidate receives a majority of votes                              |
| Term                | A logical clock in RAFT that increases with each election                                |
| WebSocket           | Protocol providing full-duplex communication channels over a single TCP connection       |
| Zero-Downtime       | Continuous availability during deployments, restarts, or failovers                       |

---

*End of SRS Document — v1.0*
