/**
 * config.js — Replica Configuration
 *
 * Reads configuration from environment variables injected by docker-compose.
 * All timing constants for Mini-RAFT are defined here.
 */

const REPLICA_ID   = process.env.REPLICA_ID || 'replica1';
const PORT         = parseInt(process.env.PORT) || 4001;
const GATEWAY_URL  = process.env.GATEWAY_URL   || 'http://gateway:3000';
const LOG_LEVEL    = (process.env.LOG_LEVEL || 'INFO').toUpperCase();

// Parse PEERS: "replica2:4002,replica3:4003" → ["http://replica2:4002", ...]
const PEERS = (process.env.PEERS || '')
  .split(',')
  .filter(Boolean)
  .map(p => `http://${p.trim()}`);

// ── Mini-RAFT Timing Constants ────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS       = 150;
const ELECTION_TIMEOUT_MIN_MS     = 500;
const ELECTION_TIMEOUT_MAX_MS     = 800;
const RPC_TIMEOUT_MS              = 300;

module.exports = {
  REPLICA_ID,
  PORT,
  GATEWAY_URL,
  LOG_LEVEL,
  PEERS,
  HEARTBEAT_INTERVAL_MS,
  ELECTION_TIMEOUT_MIN_MS,
  ELECTION_TIMEOUT_MAX_MS,
  RPC_TIMEOUT_MS,
};
