import { beforeEach, describe, expect, it } from 'vitest';
import { Outbox, type OutboxEntry } from '../../src/lib/realtime/outbox';
import { Rga } from '../../src/lib/crdt/rga';
import type { Op } from '../../src/lib/crdt/types';

/** Minimal localStorage, so the reload-survival path can be exercised in node. */
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
  clear() { this.data.clear(); }
}

const storage = new MemoryStorage();
beforeEach(() => {
  storage.clear();
  (globalThis as Record<string, unknown>).window = { localStorage: storage };
});

function entryFor(op: Op, i: number): OutboxEntry {
  return {
    opId: op.t === 'ins' ? `i:${op.id}` : `d:${op.id}`,
    documentId: 'doc-1',
    actorId: 'user-1',
    siteId: 'tab-a',
    lamport: i + 1,
    op,
  };
}

describe('outbox', () => {
  it('queues operations and reports its depth', () => {
    const outbox = new Outbox('doc-1', 'tab-a');
    const rga = new Rga('tab-a');
    const ops = rga.localInsert(0, 'queued');

    outbox.add(ops.map(entryFor));
    expect(outbox.size).toBe(6);
  });

  it('drops only the operations the database confirmed', () => {
    const outbox = new Outbox('doc-1', 'tab-a');
    const rga = new Rga('tab-a');
    const entries = rga.localInsert(0, 'abcdef').map(entryFor);
    outbox.add(entries);

    // A partial flush: the first three landed, the rest did not.
    outbox.ack(entries.slice(0, 3).map((e) => e.opId));

    expect(outbox.size).toBe(3);
    expect(outbox.all().map((e) => e.opId)).toEqual(entries.slice(3).map((e) => e.opId));
  });

  it('is safe to acknowledge the same operations twice', () => {
    const outbox = new Outbox('doc-1', 'tab-a');
    const rga = new Rga('tab-a');
    const entries = rga.localInsert(0, 'abc').map(entryFor);
    outbox.add(entries);

    const ids = entries.map((e) => e.opId);
    outbox.ack(ids);
    outbox.ack(ids); // a retried flush that actually succeeded the first time

    expect(outbox.size).toBe(0);
  });

  it('survives a page reload while offline', () => {
    const first = new Outbox('doc-1', 'tab-a');
    const rga = new Rga('tab-a');
    first.add(rga.localInsert(0, 'typed while offline').map(entryFor));
    expect(first.size).toBe(19);

    // The tab is reloaded: a brand new Outbox for the same document and session.
    const afterReload = new Outbox('doc-1', 'tab-a');
    expect(afterReload.size).toBe(19);
    expect(afterReload.all().map((e) => e.opId)).toEqual(first.all().map((e) => e.opId));
  });

  it('keeps separate queues per document and per tab', () => {
    const a = new Outbox('doc-1', 'tab-a');
    const b = new Outbox('doc-1', 'tab-b');
    const c = new Outbox('doc-2', 'tab-a');
    const rga = new Rga('tab-a');
    a.add(rga.localInsert(0, 'xy').map(entryFor));

    expect(a.size).toBe(2);
    expect(b.size).toBe(0);
    expect(c.size).toBe(0);
  });
});

describe('reconnect and replay', () => {
  /**
   * The offline story end to end.
   *
   * One replica loses the connection and keeps typing while the other carries
   * on. On reconnect the backlog is replayed -- shuffled and partly duplicated,
   * because neither ordering nor exactly-once delivery can be relied on -- and
   * both replicas must end up identical with nobody's work missing.
   */
  it('merges an offline backlog with concurrent remote edits, losing nothing', () => {
    const online = new Rga('online');
    const offline = new Rga('offline');

    const seed = online.localInsert(0, 'Base. ');
    offline.applyRemote(seed);

    // The connection drops. Both sides keep working, seeing nothing of the other.
    const offlineOps = offline.localInsert(offline.length, 'Offline work. ');
    const onlineOps = online.localInsert(online.length, 'Alice continued. ');

    // Reconnect: deliver each side's backlog to the other, out of order and
    // with duplicates, exactly as a flaky flush would.
    const backlog = [...offlineOps].reverse();
    online.applyRemote([...backlog, ...backlog.slice(0, 4)]);
    offline.applyRemote([...onlineOps].reverse());

    expect(online.text).toBe(offline.text);
    expect(online.text).toContain('Offline work.');
    expect(online.text).toContain('Alice continued.');
    expect(online.text).toContain('Base.');
  });

  it('a replayed backlog cannot duplicate text', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const ops = a.localInsert(0, 'exactly once');

    // Three flush attempts, each retrying the whole queue.
    b.applyRemote(ops);
    b.applyRemote(ops);
    b.applyRemote(ops);

    expect(b.text).toBe('exactly once');
  });

  it('catch-up after a long disconnect converges regardless of arrival order', () => {
    const server = new Rga('server');
    const seed = server.localInsert(0, 'shared document');

    const late = new Rga('late');
    late.applyRemote(seed);

    // Two peers edit while `late` is away.
    const p1 = new Rga('p1');
    const p2 = new Rga('p2');
    p1.applyRemote(seed);
    p2.applyRemote(seed);
    const p1Ops = p1.localInsert(0, 'FIRST ');
    const p2Ops = p2.localInsert(p2.length, ' LAST');

    // `late` also typed while offline.
    const lateOps = late.localInsert(7, 'MINE ');

    // Everyone eventually sees everything, each in a different order.
    late.applyRemote([...p2Ops, ...p1Ops]);
    p1.applyRemote([...lateOps, ...p2Ops]);
    p2.applyRemote([...p1Ops, ...lateOps]);

    expect(p1.text).toBe(late.text);
    expect(p2.text).toBe(late.text);
    for (const fragment of ['FIRST', 'MINE', 'LAST', 'shared']) {
      expect(late.text).toContain(fragment);
    }
    expect(late.pendingCount).toBe(0);
  });
});
