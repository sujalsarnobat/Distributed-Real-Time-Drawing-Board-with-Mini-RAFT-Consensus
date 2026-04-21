'use strict';

/**
 * helpers/wait.js
 * Shared polling / timing utilities for integration and chaos tests.
 */

/**
 * Sleep for `ms` milliseconds.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll `fn` every `intervalMs` until it returns a truthy value or `timeoutMs` elapses.
 *
 * @param {() => Promise<any>} fn   Async predicate / value factory.
 * @param {number} timeoutMs        Maximum total wait time (ms).
 * @param {number} [intervalMs=300] How often to retry.
 * @returns {Promise<any>}          The first truthy return value from `fn`.
 * @throws  Will throw the last error if `fn` never resolved within timeout.
 */
async function pollUntil(fn, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  if (lastErr) throw lastErr;
  throw new Error(`pollUntil timed out after ${timeoutMs} ms`);
}

/**
 * Poll all three replica /status endpoints until a predicate is satisfied.
 *
 * @param {(statuses: object[]) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<object[]>} Array of status objects when predicate passes.
 */
async function pollClusterUntil(axios, BASE, predicate, timeoutMs = 10000) {
  return pollUntil(async () => {
    // Use allSettled so a stopped/crashed replica doesn't abort the entire poll.
    // The predicate only sees statuses from replicas that are currently reachable.
    const results = await Promise.allSettled([
      axios.get(`${BASE.r1}/status`, { timeout: 2000 }).then(r => r.data),
      axios.get(`${BASE.r2}/status`, { timeout: 2000 }).then(r => r.data),
      axios.get(`${BASE.r3}/status`, { timeout: 2000 }).then(r => r.data),
    ]);
    const statuses = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
    return predicate(statuses) ? statuses : null;
  }, timeoutMs);
}

/**
 * Execute a shell command and return its stdout/stderr.
 * Rejects on non-zero exit code.
 */
function exec(cmd) {
  const { execSync } = require('child_process');
  return new Promise((resolve, reject) => {
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
      resolve(out.trim());
    } catch (err) {
      reject(new Error(`Command failed: ${cmd}\n${err.message}`));
    }
  });
}

/**
 * Returns true if the cluster (at least replica1) is reachable.
 * Polls for up to 15 seconds to allow Docker containers time to boot.
 */
async function isClusterUp(axios, BASE) {
  const deadline = Date.now() + 15000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      await axios.get(`${BASE.r1}/status`, { timeout: 2000 });
      // If it responded, it's up
      return true;
    } catch (err) {
      lastErr = err;
      await sleep(1000);
    }
  }
  console.warn(`[isClusterUp] Could not reach ${BASE.r1}/status — ${lastErr?.code || lastErr?.message}`);
  return false;
}

module.exports = { sleep, pollUntil, pollClusterUntil, exec, isClusterUp };
