# Architecture Document

## Distributed Real-Time Drawing Board with Mini-RAFT Consensus

| Field             | Detail                                                       |
| ----------------- | ------------------------------------------------------------ |
| **Project Title** | Distributed Real-Time Drawing Board with Mini-RAFT Consensus |
| **Version**       | 1.0                                                          |
| **Date**          | April 2026                                                   |
| **Architecture**  | Microservices (Containerised via Docker)                     |

> **Related Documents:**
> - `SRS_Document.md` — Full functional/non-functional requirements, API specs, protocol spec
> - `Implementation_Plan.md` — Week-wise execution plan, Docker deployment, testing strategy

---

## Table of Contents

1. [Cluster Overview Diagram](#1-cluster-overview-diagram)
2. [End-to-End Stroke Flow](#2-end-to-end-stroke-flow)
3. [Mini-RAFT State Transition Diagram](#3-mini-raft-state-transition-diagram)
4. [Leader Election Sequence](#4-leader-election-sequence)
5. [Log Replication Sequence](#5-log-replication-sequence)
6. [Hot-Reload Failover Sequence](#6-hot-reload-failover-sequence)
7. [API Endpoint Map](#7-api-endpoint-map)
8. [Failure Handling Summary](#8-failure-handling-summary)

---

## 1. Cluster Overview Diagram

All four microservices run inside a shared Docker bridge network (`raft-net`). Only the Gateway and Frontend ports are exposed to the host.

```mermaid
graph TB
    subgraph HOST["🖥️  Host Machine"]
        BROWSER["🌐 Browser Client\n(http://localhost:8080)"]
    end

    subgraph DOCKER["🐳 Docker Network — raft-net"]

        subgraph FE["frontend  :8080"]
            FE_APP["index.html\nstyle.css\napp.js\n(Canvas + WS Client)"]
        end

        subgraph GW["gateway  :3000"]
            GW_SRV["server.js\n(WebSocket Server\n+ HTTP Router)"]
            GW_LT["leaderTracker.js\n(Leader Discovery\n+ Stroke Forwarding)"]
        end

        subgraph R1["replica1  :4001"]
            R1_SRV["server.js"]
            R1_RAFT["raft.js\n(State Machine)"]
            R1_LOG["log.js\n(Stroke Log)"]
        end

        subgraph R2["replica2  :4002"]
            R2_SRV["server.js"]
            R2_RAFT["raft.js\n(State Machine)"]
            R2_LOG["log.js\n(Stroke Log)"]
        end

        subgraph R3["replica3  :4003"]
            R3_SRV["server.js"]
            R3_RAFT["raft.js\n(State Machine)"]
            R3_LOG["log.js\n(Stroke Log)"]
        end
    end

    BROWSER <-->|"WebSocket\n(ws://localhost:3000)"| GW_SRV
    BROWSER -->|"HTTP\n(localhost:8080)"| FE_APP

    GW_LT -->|"POST /client-stroke\n(stroke forwarding)"| R1_SRV
    R1_SRV -->|"POST /broadcast\n(committed stroke)"| GW_SRV

    R1_RAFT <-->|"POST /request-vote\nPOST /append-entries\nPOST /heartbeat"| R2_RAFT
    R1_RAFT <-->|"POST /request-vote\nPOST /append-entries\nPOST /heartbeat"| R3_RAFT
    R2_RAFT <-->|"POST /request-vote\nPOST /append-entries\nPOST /heartbeat"| R3_RAFT

    GW_LT -->|"GET /status\n(leader discovery)"| R1_SRV
    GW_LT -->|"GET /status\n(leader discovery)"| R2_SRV
    GW_LT -->|"GET /status\n(leader discovery)"| R3_SRV
```

### Port Reference

| Service    | Container  | Host Port | Internal Port | Role                        |
| ---------- | ---------- | --------- | ------------- | --------------------------- |
| Frontend   | `frontend` | `8080`    | `8080`        | Static canvas SPA           |
| Gateway    | `gateway`  | `3000`    | `3000`        | WebSocket + HTTP router     |
| Replica 1  | `replica1` | `4001`    | `4001`        | RAFT consensus node         |
| Replica 2  | `replica2` | `4002`    | `4002`        | RAFT consensus node         |
| Replica 3  | `replica3` | `4003`    | `4003`        | RAFT consensus node         |

---

## 2. End-to-End Stroke Flow

The complete path a drawing stroke takes from the browser to all connected clients.

```mermaid
flowchart TD
    A(["👤 User draws on canvas"])
    B["Frontend\nCaptures mousedown → mousemove → mouseup\nBuilds stroke: { points, color, width }"]
    C["Frontend → Gateway\nWebSocket: { type: 'stroke', data: stroke }"]
    D["Gateway\nleaderTracker.forwardStroke(stroke)"]
    E["Leader Replica\nPOST /client-stroke"]
    F["Leader\nAppends to local log\nlog.append(term, stroke)"]
    G["Leader → Followers\nPOST /append-entries to replica2 + replica3\n{ term, leaderId, prevLogIndex, prevLogTerm, entry, leaderCommit }"]
    H{"Majority ACK?\n≥ 2 of 3"}
    I["Leader\nMarks entry as committed\nlog.commit(index)\ncommitIndex++"]
    J["Leader → Gateway\nPOST /broadcast\n{ stroke: { index, points, color, width } }"]
    K["Gateway\nBroadcasts to ALL WebSocket clients\n{ type: 'stroke-committed', data: stroke }"]
    L(["🖥️ All browser tabs render stroke"])
    M["Leader retries or drops\n(no quorum — 2 replicas down)"]

    A --> B --> C --> D --> E --> F --> G --> H
    H -->|"Yes"| I --> J --> K --> L
    H -->|"No"| M
```

---

## 3. Mini-RAFT State Transition Diagram

Each replica node is always in exactly one of three states. The transitions are driven by timeouts, RPCs received, and vote counts.

```mermaid
stateDiagram-v2
    [*] --> Follower : Boot / Restart

    Follower --> Candidate : Election timeout expires\n(no heartbeat received\nwithin 500–800 ms)

    Candidate --> Follower : Receives heartbeat or AppendEntries\nwith term ≥ own term\n(another leader exists)

    Candidate --> Follower : Receives RPC with\nhigher term than own

    Candidate --> Candidate : Split vote — no majority\n(restart election with\nnew random timeout)

    Candidate --> Leader : Receives votes from\nmajority ≥ 2 of 3 peers

    Leader --> Follower : Receives any RPC\nwith term > own term\n(step down immediately)

    note right of Follower
        · Passive — waits for heartbeats
        · Resets election timer on each heartbeat
        · Responds to RequestVote + AppendEntries
        · votedFor = null (reset each new term)
    end note

    note right of Candidate
        · Increments currentTerm
        · Votes for itself
        · Sends RequestVote to all peers (parallel)
        · Waits for majority or timeout
    end note

    note right of Leader
        · Sends heartbeats every 150 ms
        · Accepts strokes via /client-stroke
        · Replicates via /append-entries
        · Commits on majority ACK
        · Notifies Gateway via /broadcast
    end note
```

---

## 4. Leader Election Sequence

What happens from the moment a follower stops receiving heartbeats until a new leader is elected.

```mermaid
sequenceDiagram
    participant R1 as replica1 (was Leader)
    participant R2 as replica2 (Follower)
    participant R3 as replica3 (Follower → new Leader)
    participant GW as Gateway

    Note over R1: 💥 Leader crashes / hot-reloads

    Note over R2,R3: Election timeout fires (500–800 ms random)
    Note over R3: R3 fires first (shorter timeout)

    R3->>R3: state = Candidate, term++, votedFor = self

    par RequestVote RPCs (parallel)
        R3->>R2: POST /request-vote { term: N, candidateId: replica3, lastLogIndex, lastLogTerm }
        R2-->>R3: { term: N, voteGranted: true }
        R3->>R1: POST /request-vote { term: N, candidateId: replica3, ... }
        Note over R1: Unreachable — timeout
    end

    Note over R3: votes = 2 (self + R2) ≥ majority
    R3->>R3: state = Leader
    R3->>R3: Start heartbeat timer (every 150 ms)

    R3->>R2: POST /heartbeat { term: N, leaderId: replica3, leaderCommit }
    R2-->>R3: { term: N, success: true }

    GW->>R1: GET /status (polling every 2 s)
    Note over R1: Unreachable
    GW->>R2: GET /status
    R2-->>GW: { state: "Follower", leader: "replica3" }
    GW->>R3: GET /status
    R3-->>GW: { state: "Leader", id: "replica3" }

    Note over GW: currentLeader = http://replica3:4003
    Note over GW: Re-routes all future strokes to replica3
```

---

## 5. Log Replication Sequence

How a committed stroke travels from the leader's log to all followers (happy path).

```mermaid
sequenceDiagram
    participant GW as Gateway
    participant L as Leader (replica1)
    participant F2 as Follower (replica2)
    participant F3 as Follower (replica3)

    GW->>L: POST /client-stroke { stroke: { points, color, width } }
    L->>L: log.append(term, stroke)\nentry = { index: 6, term: 3, stroke, committed: false }

    par AppendEntries RPCs (parallel)
        L->>F2: POST /append-entries { term, leaderId, prevLogIndex: 5, prevLogTerm: 3, entry, leaderCommit: 5 }
        F2->>F2: prevLogIndex check ✅ → log.append(entry)
        F2-->>L: { term: 3, success: true }

        L->>F3: POST /append-entries { term, leaderId, prevLogIndex: 5, prevLogTerm: 3, entry, leaderCommit: 5 }
        F3->>F3: prevLogIndex check ✅ → log.append(entry)
        F3-->>L: { term: 3, success: true }
    end

    Note over L: ACKs received: 2 (F2 + F3) + self = 3 ≥ majority (2)
    L->>L: log.commit(6)\ncommitIndex = 6

    L->>GW: POST /broadcast { stroke: { index: 6, points, color, width } }
    GW-->>L: { success: true }

    GW->>GW: Broadcast to all WebSocket clients\n{ type: "stroke-committed", data: stroke }
```

---

## 6. Hot-Reload Failover Sequence

What happens when a source file in a replica's directory is edited on the host — triggering nodemon to restart the container.

```mermaid
sequenceDiagram
    participant DEV as Developer (Host)
    participant R1 as replica1 (was Leader)
    participant R2 as replica2
    participant R3 as replica3
    participant GW as Gateway
    participant FE as Frontend (Browser)

    DEV->>R1: Edit replica1/raft.js (save file)
    Note over R1: nodemon detects change → process restarts

    R1--xR2: Heartbeats stop
    R1--xR3: Heartbeats stop

    Note over R2,R3: Election timeout fires (500–800 ms)
    Note over R2: R2 fires first → starts election

    R2->>R2: state = Candidate, term++
    R2->>R3: POST /request-vote
    R3-->>R2: { voteGranted: true }
    Note over R2: Majority reached → becomes Leader

    R2->>R3: POST /heartbeat (every 150 ms)

    GW->>GW: /status poll detects new leader = replica2
    Note over GW: currentLeader updated — NO client WS disconnect

    Note over R1: Container restarts → starts as Follower (empty log)
    R2->>R1: POST /heartbeat { term: N, leaderId: replica2 }
    R1-->>R2: { success: true }
    Note over R1: Election timer reset — stays Follower

    R2->>R1: POST /append-entries (next stroke)\nprevLogIndex check FAILS (empty log)
    R1-->>R2: { success: false, logLength: 0 }

    R2->>R1: POST /sync-log { entries: [all committed entries], leaderCommit }
    R1->>R1: Appends all entries\ncommitIndex catches up
    R1-->>R2: { success: true, logLength: N }

    Note over R1,R3: Cluster fully restored — 3 nodes healthy
    Note over FE: Canvas consistent — no disruption to clients
```

---

## 7. API Endpoint Map

Complete reference of all HTTP endpoints and WebSocket messages in the system.

```mermaid
graph LR
    subgraph REPLICA["Replica Nodes (replica1 / 2 / 3)"]
        RV["POST /request-vote\nCandidate → Peer\nVote grant/deny"]
        AE["POST /append-entries\nLeader → Follower\nLog replication"]
        HB["POST /heartbeat\nLeader → Follower\nLiveness + timer reset"]
        SL["POST /sync-log\nLeader → Lagging Follower\nCatch-up all missing entries"]
        CS["POST /client-stroke\nGateway → Leader\nAccept a new stroke"]
        ST["GET /status\nAny client / Gateway\nQuery RAFT state"]
    end

    subgraph GATEWAY["Gateway (:3000)"]
        BC["POST /broadcast\nLeader → Gateway\nPush committed stroke"]
        HLT["GET /health\nAny client\nGateway liveness check"]
        WSS["WebSocket :3000\nFrontend ↔ Gateway\nBidirectional stroke stream"]
    end

    subgraph WS_MSGS["WebSocket Message Types"]
        WS1["Client→Gateway\ntype: 'stroke'\ndata: { points, color, width }"]
        WS2["Gateway→Client\ntype: 'stroke-committed'\ndata: { index, points, color, width }"]
        WS3["Gateway→Client\ntype: 'full-sync'\ndata: { strokes: [...] }"]
    end

    WSS --- WS1
    WSS --- WS2
    WSS --- WS3
```

### `/status` Response Shape

All replicas expose the same status response format (SRS §6.1):

```json
{
  "id":          "replica1",
  "state":       "Leader",
  "term":        3,
  "leader":      "replica1",
  "logLength":   5,
  "commitIndex": 5
}
```

---

## 8. Failure Handling Summary

How the system responds to each class of failure, and the expected recovery time.

```mermaid
graph TD
    subgraph FAILURES["Failure Classes"]
        F1["💥 Leader Crashes\ndocker stop leader"]
        F2["💥 Follower Crashes\ndocker stop follower"]
        F3["🔄 Leader Hot-Reloads\nfile edit → nodemon restart"]
        F4["🔄 Follower Hot-Reloads\nfile edit → nodemon restart"]
        F5["📡 Gateway Cannot Reach Leader\nHTTP timeout ≥ 2 s"]
        F6["🖥️ Client WS Disconnects\nnetwork drop"]
        F7["⚖️ Split Vote During Election\nboth candidates tie"]
    end

    subgraph RESPONSES["System Response"]
        R1["Followers detect missed heartbeats\n→ Election → New leader\n→ Gateway re-routes\nRecovery: < 2 s"]
        R2["Leader continues with remaining quorum\n→ Crashed follower syncs on restart\nNo data loss"]
        R3["Container restarts as Follower\n→ Election triggered\n→ New leader elected\n→ Restarted node syncs via /sync-log\nNo client disconnect"]
        R4["Follower restarts → catches up\nNo election needed\nTransparent to clients"]
        R5["Gateway polls all replicas at /status\n→ Discovers new leader\n→ Replays queued strokes\nStrokes delivered once leader found"]
        R6["Client reconnects\n→ Gateway sends full-sync\n→ Client re-renders canvas\nCanvas fully consistent"]
        R7["Both candidates timeout\n→ New election with new random timeout\n→ One candidate wins\nResolves in 1–2 election cycles"]
    end

    F1 --> R1
    F2 --> R2
    F3 --> R3
    F4 --> R4
    F5 --> R5
    F6 --> R6
    F7 --> R7
```

### RAFT Timing Constants (from `config.js`)

| Parameter              | Value    | Purpose                                    |
| ---------------------- | -------- | ------------------------------------------ |
| Heartbeat Interval     | `150 ms` | Leader → all Followers liveness signal     |
| Election Timeout Min   | `500 ms` | Randomised lower bound for election trigger|
| Election Timeout Max   | `800 ms` | Randomised upper bound for election trigger|
| HTTP RPC Timeout       | `300 ms` | During inter-replica RPC calls             |
| Gateway Leader Timeout | `2000 ms`| Before Gateway initiates re-discovery      |

---

*End of Architecture Document — v1.0*
