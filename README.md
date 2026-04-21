# Mini-RAFT Drawing Board

A distributed real-time collaborative drawing board built with a Mini-RAFT consensus protocol.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) ≥ 24
- [Docker Compose](https://docs.docker.com/compose/) ≥ 2

## Getting Started

```bash
# Clone the repository
git clone <repo-url>
cd Mini-RAFT-Drawing-Board

# Build and start all services
docker-compose up --build
```

Open your browser at **http://localhost:8080** to access the drawing board.

## Services

| Service   | URL                        | Description                  |
|-----------|----------------------------|------------------------------|
| Frontend  | http://localhost:8080      | Browser drawing canvas       |
| Gateway   | http://localhost:3000      | WebSocket server             |
| Replica 1 | Internal only (`raft-net`) | RAFT consensus node          |
| Replica 2 | Internal only (`raft-net`) | RAFT consensus node          |
| Replica 3 | Internal only (`raft-net`) | RAFT consensus node          |
| Replica 4 | Internal only (`raft-net`) | Optional RAFT node (scale override) |

## Scalability

### Add a 4th replica (without backend code changes)

```bash
# Start base stack + 4-node topology override
docker compose -f docker-compose.yml -f docker-compose.scale4.yml up -d --build
```

The override file updates Gateway replica discovery and all peer lists so quorum stays correct for 4 nodes (majority = 3).

### Add more clients

No backend cluster changes are needed. Clients connect to the Gateway WebSocket endpoint, and the Gateway fan-outs committed strokes to all active connections.

## Common Commands

```bash
# Start all services (detached)
docker-compose up -d --build

# View logs for a specific service
docker logs -f replica1

# Simulate a leader failure
docker-compose stop replica1

# Restart a replica (simulates hot-reload)
docker-compose restart replica1

# Trigger hot-reload by editing source
# (edit any file in replica1/ — container restarts automatically)

# Check Gateway health (includes current leader)
curl http://localhost:3000/health

# Tear down everything
docker-compose down
```

## Documentation

- [`documentation/SRS_Document.md`](documentation/SRS_Document.md) — Requirements, API specs, protocol spec
- [`documentation/Implementation_Plan.md`](documentation/Implementation_Plan.md) — Week-wise plan, Docker setup, testing strategy