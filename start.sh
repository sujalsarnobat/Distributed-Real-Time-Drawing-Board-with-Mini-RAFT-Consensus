#!/bin/sh
set -e

# Base Gateway URL for replicas to notify
GATEWAY_TARGET="http://127.0.0.1:${PORT:-3000}"

echo "[START] Starting Replica 1 on port 4001..."
(cd /app/replica1 && REPLICA_ID="replica1" PORT=4001 PEERS="127.0.0.1:4002,127.0.0.1:4003" GATEWAY_URL="$GATEWAY_TARGET" node server.js) &

echo "[START] Starting Replica 2 on port 4002..."
(cd /app/replica2 && REPLICA_ID="replica2" PORT=4002 PEERS="127.0.0.1:4001,127.0.0.1:4003" GATEWAY_URL="$GATEWAY_TARGET" node server.js) &

echo "[START] Starting Replica 3 on port 4003..."
(cd /app/replica3 && REPLICA_ID="replica3" PORT=4003 PEERS="127.0.0.1:4001,127.0.0.1:4002" GATEWAY_URL="$GATEWAY_TARGET" node server.js) &

# Brief pause to allow replicas to bind ports
sleep 2

echo "[START] Starting Gateway on port ${PORT:-3000}..."
export REPLICAS="127.0.0.1:4001,127.0.0.1:4002,127.0.0.1:4003"
cd /app/gateway && PORT=${PORT:-3000} node server.js
