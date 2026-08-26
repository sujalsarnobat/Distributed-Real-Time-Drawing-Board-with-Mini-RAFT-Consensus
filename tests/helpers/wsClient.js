'use strict';

/**
 * helpers/wsClient.js
 *
 * Thin WebSocket test-client wrapper that turns the event-based WS API
 * into a Promise-based API for use inside Jest tests.
 *
 * Usage:
 *   const tab = await WsTestClient.connect('ws://localhost:3000');
 *   const msg = await tab.waitForType('full-sync', 3000);
 *   tab.send({ type: 'ping' });
 *   const pong = await tab.waitForType('pong', 2000);
 *   tab.close();
 */

const WebSocket = require('ws');

class WsTestClient {
  /**
   * @param {string} url   WebSocket server URL.
   * @param {number} [connectTimeoutMs=5000]
   */
  constructor(url, connectTimeoutMs = 5000) {
    this.url = url;
    this._ws = null;
    this._messageQueue = [];       // Received messages not yet consumed
    this._waiters     = [];        // Pending waitForType / waitNext resolvers
    this.connectTimeoutMs = connectTimeoutMs;
  }

  /**
   * Open the connection and wait until it is OPEN.
   * Returns `this` for chaining.
   */
  connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`WS connect timeout to ${this.url}`)),
        this.connectTimeoutMs
      );

      this._ws = new WebSocket(this.url);

      this._ws.on('open', () => {
        clearTimeout(timer);
        resolve(this);
      });

      this._ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // Try to satisfy a pending waiter first
        const idx = this._waiters.findIndex(w => w.predicate(msg));
        if (idx !== -1) {
          const [waiter] = this._waiters.splice(idx, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
        } else {
          // No waiter — park message for later consumption
          this._messageQueue.push(msg);
        }
      });

      this._ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      this._ws.on('close', () => {
        // Reject all pending waiters
        for (const w of this._waiters) {
          clearTimeout(w.timer);
          w.reject(new Error('WebSocket closed while waiting for message'));
        }
        this._waiters = [];
      });
    });
  }

  /**
   * Static factory — connect and return the client.
   */
  static async connect(url, connectTimeoutMs = 5000) {
    return new WsTestClient(url, connectTimeoutMs).connect();
  }

  /**
   * Send a JSON payload to the server.
   */
  send(payload) {
    this._ws.send(JSON.stringify(payload));
  }

  /**
   * Wait for the next message that satisfies an optional predicate.
   * First checks the messageQueue for already-arrived messages.
   *
   * @param {(msg: object) => boolean} [predicate]  Defaults to always-true.
   * @param {number} [timeoutMs=5000]
   */
  waitNext(predicate = () => true, timeoutMs = 5000) {
    // Check already-queued messages
    const idx = this._messageQueue.findIndex(predicate);
    if (idx !== -1) {
      return Promise.resolve(this._messageQueue.splice(idx, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const i = this._waiters.findIndex(w => w.resolve === resolve);
          if (i !== -1) this._waiters.splice(i, 1);
          reject(new Error(`WS: timed out waiting for message (${timeoutMs} ms)`));
        },
        timeoutMs
      );
      this._waiters.push({ predicate, resolve, reject, timer });
    });
  }

  /**
   * Convenience: wait for a message of a specific `type`.
   *
   * @param {string} type
   * @param {number} [timeoutMs=5000]
   */
  waitForType(type, timeoutMs = 5000) {
    return this.waitNext(msg => msg.type === type, timeoutMs);
  }

  /**
   * Register a listener BEFORE sending a stroke so there is no race condition
   * where the `stroke-committed` arrives before the listener is attached.
   * Returns a Promise that resolves with the committed message.
   */
  expectStrokeCommitted(timeoutMs = 5000) {
    return this.waitForType('stroke-committed', timeoutMs);
  }

  /** Gracefully close the connection. */
  close() {
    if (this._ws && this._ws.readyState !== WebSocket.CLOSED) {
      this._ws.close();
    }
  }

  /** Number of messages sitting in the queue (not yet consumed). */
  get queueLength() {
    return this._messageQueue.length;
  }
}

module.exports = WsTestClient;
