'use strict';

/**
 * unit/log.test.js — Unit tests for replica1/log.js (StrokeLog)
 *
 * Coverage:
 *  ✓ append()        — sequential index, correct fields, committed=false
 *  ✓ getEntry()      — 1-based lookup, undefined on miss
 *  ✓ lastIndex()     — 0 on empty, length after appends
 *  ✓ lastTerm()      — 0 on empty, last entry's term
 *  ✓ getFrom()       — all entries for index<1, slice for index≥1
 *  ✓ commit()        — marks entry committed, ignores missing index
 *  ✓ truncateFrom()  — removes uncommitted tail, never removes committed
 *  ✓ getCommitted()  — only committed entries
 *  ✓ length          — getter matches entries.length
 */

// A fresh StrokeLog instance is created before each test via resetModules().
let log;

beforeEach(() => {
  jest.resetModules();
  const StrokeLog = require('../../replica1/log');
  log = new StrokeLog();
});

// ─────────────────────────────────────────────────────────────────────────────
// append()
// ─────────────────────────────────────────────────────────────────────────────

describe('append()', () => {
  test('returns an entry with index=1 for the first append', () => {
    const stroke = { points: [{ x: 0, y: 0 }], color: 'red', width: 3 };
    const entry = log.append(1, stroke);

    expect(entry.index).toBe(1);
    expect(entry.term).toBe(1);
    expect(entry.stroke).toBe(stroke);
    expect(entry.committed).toBe(false);
  });

  test('indices are sequential across multiple appends', () => {
    const e1 = log.append(1, { points: [], color: 'red',  width: 2 });
    const e2 = log.append(1, { points: [], color: 'blue', width: 3 });
    const e3 = log.append(2, { points: [], color: 'green',width: 4 });

    expect(e1.index).toBe(1);
    expect(e2.index).toBe(2);
    expect(e3.index).toBe(3);
  });

  test('entry is stored and retrievable immediately after append', () => {
    const stroke = { points: [{ x: 5, y: 10 }], color: 'blue', width: 2 };
    log.append(1, stroke);

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].stroke).toBe(stroke);
  });

  test('term is stored per entry independently', () => {
    const e1 = log.append(1, {});
    const e2 = log.append(3, {});

    expect(e1.term).toBe(1);
    expect(e2.term).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getEntry()
// ─────────────────────────────────────────────────────────────────────────────

describe('getEntry()', () => {
  test('returns undefined on an empty log', () => {
    expect(log.getEntry(1)).toBeUndefined();
  });

  test('retrieves the correct entry by 1-based index', () => {
    log.append(1, { color: 'red' });
    log.append(1, { color: 'blue' });

    expect(log.getEntry(1).stroke).toEqual({ color: 'red' });
    expect(log.getEntry(2).stroke).toEqual({ color: 'blue' });
  });

  test('returns undefined for index beyond log length', () => {
    log.append(1, {});
    expect(log.getEntry(99)).toBeUndefined();
  });

  test('index 0 returns undefined (log is 1-based)', () => {
    log.append(1, {});
    expect(log.getEntry(0)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lastIndex() / lastTerm()
// ─────────────────────────────────────────────────────────────────────────────

describe('lastIndex()', () => {
  test('returns 0 on empty log', () => {
    expect(log.lastIndex()).toBe(0);
  });

  test('returns the index of the last appended entry', () => {
    log.append(1, {});
    log.append(1, {});
    log.append(2, {});
    expect(log.lastIndex()).toBe(3);
  });
});

describe('lastTerm()', () => {
  test('returns 0 on empty log', () => {
    expect(log.lastTerm()).toBe(0);
  });

  test('returns the term of the most recently appended entry', () => {
    log.append(1, {});
    log.append(3, {});
    expect(log.lastTerm()).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getFrom()
// ─────────────────────────────────────────────────────────────────────────────

describe('getFrom()', () => {
  beforeEach(() => {
    log.append(1, { color: 'a' });
    log.append(1, { color: 'b' });
    log.append(2, { color: 'c' });
  });

  test('index < 1 returns all entries', () => {
    expect(log.getFrom(0)).toHaveLength(3);
    expect(log.getFrom(-5)).toHaveLength(3);
  });

  test('index = 1 returns all entries', () => {
    expect(log.getFrom(1)).toHaveLength(3);
  });

  test('index = 2 returns entries from index 2 onward', () => {
    const result = log.getFrom(2);
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(2);
    expect(result[1].index).toBe(3);
  });

  test('index beyond log length returns empty array', () => {
    expect(log.getFrom(10)).toHaveLength(0);
  });

  test('result is a copy — does not reference internal array', () => {
    const result = log.getFrom(1);
    result.push({ fake: true });
    expect(log.entries).toHaveLength(3); // internal untouched
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// commit()
// ─────────────────────────────────────────────────────────────────────────────

describe('commit()', () => {
  test('marks the target entry as committed', () => {
    log.append(1, {});
    log.append(1, {});
    log.commit(1);

    expect(log.getEntry(1).committed).toBe(true);
    expect(log.getEntry(2).committed).toBe(false);
  });

  test('committing an out-of-range index is a no-op', () => {
    log.append(1, {});
    expect(() => log.commit(99)).not.toThrow();
    expect(log.getEntry(1).committed).toBe(false);
  });

  test('committing the same entry twice is idempotent', () => {
    log.append(1, {});
    log.commit(1);
    log.commit(1); // second call
    expect(log.getEntry(1).committed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// truncateFrom()
// ─────────────────────────────────────────────────────────────────────────────

describe('truncateFrom()', () => {
  test('removes uncommitted entries from the given index onward', () => {
    log.append(1, { color: 'a' });
    log.append(1, { color: 'b' });
    log.append(1, { color: 'c' });

    log.truncateFrom(2); // remove entries 2 and 3

    expect(log.entries).toHaveLength(1);
    expect(log.getEntry(1).stroke).toEqual({ color: 'a' });
  });

  test('never removes committed entries', () => {
    log.append(1, { color: 'a' }); // index 1 — committed
    log.append(1, { color: 'b' }); // index 2 — uncommitted
    log.commit(1);

    log.truncateFrom(1); // tries to start at 1 but 1 is committed → start at 2

    expect(log.entries).toHaveLength(1);
    expect(log.getEntry(1).committed).toBe(true);
  });

  test('truncateFrom beyond log length is a no-op', () => {
    log.append(1, {});
    log.truncateFrom(10); // nothing to remove
    expect(log.entries).toHaveLength(1);
  });

  test('removes all uncommitted entries when truncating from index 1', () => {
    log.append(1, {});
    log.append(1, {});
    log.truncateFrom(1);
    expect(log.entries).toHaveLength(0);
  });

  test('mixed committed/uncommitted: only uncommitted tail removed', () => {
    log.append(1, {}); // 1 committed
    log.append(1, {}); // 2 committed
    log.append(2, {}); // 3 uncommitted
    log.append(2, {}); // 4 uncommitted
    log.commit(1);
    log.commit(2);

    log.truncateFrom(2); // 2 is committed → safe start = 3

    expect(log.entries).toHaveLength(2); // only 1 and 2 remain
    expect(log.getEntry(1).committed).toBe(true);
    expect(log.getEntry(2).committed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCommitted()
// ─────────────────────────────────────────────────────────────────────────────

describe('getCommitted()', () => {
  test('returns empty array when nothing is committed', () => {
    log.append(1, {});
    log.append(1, {});
    expect(log.getCommitted()).toHaveLength(0);
  });

  test('returns only committed entries', () => {
    log.append(1, { color: 'a' });
    log.append(1, { color: 'b' });
    log.append(1, { color: 'c' });
    log.commit(1);
    log.commit(3);

    const committed = log.getCommitted();
    expect(committed).toHaveLength(2);
    expect(committed.map(e => e.index)).toEqual([1, 3]);
  });

  test('returns empty array on empty log', () => {
    expect(log.getCommitted()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// length getter
// ─────────────────────────────────────────────────────────────────────────────

describe('length getter', () => {
  test('is 0 on fresh log', () => {
    expect(log.length).toBe(0);
  });

  test('matches the number of appended entries regardless of commit state', () => {
    log.append(1, {});
    log.append(1, {});
    log.commit(1);
    log.append(2, {});

    expect(log.length).toBe(3);
  });
});
