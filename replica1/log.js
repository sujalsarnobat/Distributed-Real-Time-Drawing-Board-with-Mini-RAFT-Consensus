/**
 * log.js — Append-Only Stroke Log
 *
 * Responsibilities:
 *  - Maintain an in-memory append-only array of log entries
 *  - Each entry: { index, term, stroke, committed }
 *  - Provide helpers: append, getEntry, lastIndex, lastTerm, getFrom, commit,
 *                     truncateFrom, getCommitted
 *
 * RAFT Safety Rules:
 *  - Committed entries are NEVER overwritten (truncateFrom guards this)
 *  - Log index is 1-based
 *
 * Multi-tenant change: exports the StrokeLog CLASS (not a singleton instance)
 * so raft.js can maintain one StrokeLog per boardId in a Map.
 *
 * [BUG-7 FIX] truncateFrom now emits a warning when called beyond log length.
 */

class StrokeLog {
  constructor() {
    /** @type {Array<{ index: number, term: number, stroke: object, committed: boolean }>} */
    this.entries = [];
  }

  /** Append a new entry to the log. Returns the new entry. */
  append(term, stroke) {
    const entry = {
      index:     this.entries.length + 1,
      term,
      stroke,
      committed: false,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Get entry by 1-based index. Returns undefined if not found. */
  getEntry(index) {
    return this.entries[index - 1];
  }

  /** Return the index of the last entry (0 if log is empty). */
  lastIndex() {
    return this.entries.length;
  }

  /** Return the term of the last entry (0 if log is empty). */
  lastTerm() {
    return this.entries.length > 0
      ? this.entries[this.entries.length - 1].term
      : 0;
  }

  /**
   * Return all entries from startIndex (1-based) onward.
   * Used by /sync-log to send missing entries to a restarted follower.
   */
  getFrom(startIndex) {
    if (startIndex < 1) return [...this.entries];
    return this.entries.slice(startIndex - 1);
  }

  /** Mark an entry as committed by its 1-based index. */
  commit(index) {
    const entry = this.getEntry(index);
    if (entry) {
      entry.committed = true;
    }
  }

  /**
   * Truncate all entries from startIndex (1-based) onward.
   * Only removes UNCOMMITTED entries — committed entries are never removed.
   * Called when a follower detects a log conflict with the leader.
   */
  truncateFrom(startIndex) {
    // Find the highest committed index to protect
    const lastCommitted = this.entries.reduce((max, e) => {
      return e.committed ? Math.max(max, e.index) : max;
    }, 0);

    // Never truncate committed entries
    const safeStart = Math.max(startIndex, lastCommitted + 1);

    // [BUG-7 FIX] Detect no-op truncations that would silently hide divergence bugs
    if (safeStart > this.entries.length) {
      console.warn(
        `${new Date().toISOString()} [WARN ][LOG] truncateFrom(${startIndex}) is beyond` +
        ` log length (${this.entries.length}) — no-op (safeStart=${safeStart})`
      );
      return;
    }

    if (safeStart <= this.entries.length) {
      this.entries = this.entries.slice(0, safeStart - 1);
    }
  }

  /** Return all committed entries (for full-sync to Gateway/clients). */
  getCommitted() {
    return this.entries.filter(e => e.committed);
  }

  /** Return the current length of the log. */
  get length() {
    return this.entries.length;
  }
}

// Export the class — raft.js instantiates one StrokeLog per boardId
module.exports = StrokeLog;
