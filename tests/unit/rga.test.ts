import { describe, expect, it } from 'vitest';
import { Rga } from '../../src/lib/crdt/rga';
import { diffToOps } from '../../src/lib/crdt/diff';
import type { Op } from '../../src/lib/crdt/types';

/** Deterministic PRNG so a failing seed can be replayed exactly. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('Rga basics', () => {
  it('inserts and deletes locally', () => {
    const a = new Rga('a');
    a.localInsert(0, 'hello world');
    expect(a.text).toBe('hello world');
    a.localDelete(5, 6);
    expect(a.text).toBe('hello');
  });

  it('is idempotent under duplicate delivery', () => {
    const a = new Rga('a');
    const ops = a.localInsert(0, 'abc');
    const b = new Rga('b');
    b.applyRemote(ops);
    b.applyRemote(ops);
    b.applyRemote(ops);
    expect(b.text).toBe('abc');
  });

  it('tombstones rather than splicing, so ids stay stable', () => {
    const a = new Rga('a');
    a.localInsert(0, 'abcdef');
    const idOfE = a.idAtIndex(4);
    a.localDelete(0, 3);
    expect(a.text).toBe('def');
    expect(a.indexOfId(idOfE!)).toBe(1);
  });

  it('buffers operations that arrive before their causal dependency', () => {
    const a = new Rga('a');
    const ops = a.localInsert(0, 'abc');
    const b = new Rga('b');

    // Deliver in reverse: every op arrives before the one it depends on.
    b.applyRemote([ops[2]]);
    b.applyRemote([ops[1]]);
    expect(b.pendingCount).toBeGreaterThan(0);
    b.applyRemote([ops[0]]);

    expect(b.text).toBe('abc');
    expect(b.pendingCount).toBe(0);
  });
});

describe('concurrent editing', () => {
  it('keeps BOTH edits when two users type into the same sentence at once', () => {
    // The headline case from the brief: Alice and Bob edit the same sentence at
    // almost exactly the same moment. Neither may lose their work.
    const alice = new Rga('alice');
    const bob = new Rga('bob');

    const seed = alice.localInsert(0, 'The quick fox');
    bob.applyRemote(seed);

    const aliceOps = alice.localInsert(10, 'brown ');
    const bobOps = bob.localInsert(10, 'clever ');

    alice.applyRemote(bobOps);
    bob.applyRemote(aliceOps);

    expect(alice.text).toBe(bob.text);
    expect(alice.text).toContain('brown');
    expect(alice.text).toContain('clever');
    expect(alice.text.startsWith('The quick ')).toBe(true);
    expect(alice.text.endsWith('fox')).toBe(true);
  });

  it('converges when both users delete overlapping ranges', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const seed = a.localInsert(0, 'abcdefghij');
    b.applyRemote(seed);

    const aOps = a.localDelete(2, 4); // cdef
    const bOps = b.localDelete(4, 4); // efgh

    a.applyRemote(bOps);
    b.applyRemote(aOps);

    expect(a.text).toBe(b.text);
    expect(a.text).toBe('abij');
  });

  it('converges when one user edits inside text another user is deleting', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const seed = a.localInsert(0, 'hello world');
    b.applyRemote(seed);

    const aOps = a.localDelete(0, 5);
    const bOps = b.localInsert(3, 'XYZ');

    a.applyRemote(bOps);
    b.applyRemote(aOps);

    expect(a.text).toBe(b.text);
    expect(a.text).toContain('XYZ'); // the surviving insert is not swallowed
  });
});

describe('convergence property', () => {
  it('three replicas converge under 500 randomised interleavings', () => {
    for (let iteration = 0; iteration < 500; iteration++) {
      const rand = rng(iteration + 1);
      const sites = ['alpha', 'bravo', 'charlie'];
      const replicas = sites.map((s) => new Rga(s));

      // Shared starting point.
      const seedOps = replicas[0].localInsert(0, 'shared baseline text');
      replicas[1].applyRemote(seedOps);
      replicas[2].applyRemote(seedOps);

      // Each replica edits independently, seeing none of the others' work.
      const generated: Op[][] = replicas.map((r) => {
        const ops: Op[] = [];
        const editCount = 1 + Math.floor(rand() * 4);
        for (let e = 0; e < editCount; e++) {
          const len = r.length;
          if (rand() < 0.6 || len === 0) {
            const at = Math.floor(rand() * (len + 1));
            const word = ['cat', 'dog', ' ', 'xy', 'hello'][Math.floor(rand() * 5)];
            ops.push(...r.localInsert(at, word));
          } else {
            const at = Math.floor(rand() * len);
            const count = 1 + Math.floor(rand() * Math.min(4, len - at));
            ops.push(...r.localDelete(at, count));
          }
        }
        return ops;
      });

      // Deliver everyone else's operations in a different shuffled order to each
      // replica -- and deliver some of them twice.
      replicas.forEach((replica, i) => {
        const incoming: Op[] = [];
        generated.forEach((ops, j) => {
          if (i !== j) incoming.push(...ops);
        });
        const withDupes = [...incoming, ...incoming.slice(0, Math.floor(incoming.length / 3))];
        replica.applyRemote(shuffle(withDupes, rand));
      });

      expect(replicas[0].pendingCount, `seed ${iteration}`).toBe(0);
      expect(replicas[1].text, `seed ${iteration}`).toBe(replicas[0].text);
      expect(replicas[2].text, `seed ${iteration}`).toBe(replicas[0].text);
    }
  });
});

describe('cursor and anchor rebasing', () => {
  it('holds a caret in place when a remote insert lands above it', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    b.applyRemote(a.localInsert(0, 'hello world'));

    const caret = a.cursorFromIndex(11); // end of text
    const bOps = b.localInsert(0, 'XXXX ');
    a.applyRemote(bOps);

    // The caret follows its character, so it stays after "world".
    expect(a.indexFromCursor(caret)).toBe(16);
    expect(a.text).toBe('XXXX hello world');
  });

  it('falls back to the nearest survivor when the anchor is deleted', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    b.applyRemote(a.localInsert(0, 'hello world'));

    const caret = a.cursorFromIndex(5); // after "hello"
    a.applyRemote(b.localDelete(0, 5)); // someone deletes "hello"

    expect(() => a.indexFromCursor(caret)).not.toThrow();
    expect(a.indexFromCursor(caret)).toBe(0);
    expect(a.text).toBe(' world');
  });
});

describe('diff to operations', () => {
  it('emits one insert for one typed character', () => {
    const a = new Rga('a');
    a.localInsert(0, 'hello');
    const ops = diffToOps(a, 'hellp');
    expect(a.text).toBe('hellp');
    expect(ops.filter((o) => o.t === 'ins')).toHaveLength(1);
    expect(ops.filter((o) => o.t === 'del')).toHaveLength(1);
  });

  it('does not rewrite the document when replacing one word', () => {
    const a = new Rga('a');
    a.localInsert(0, 'the quick brown fox jumps');
    const ops = diffToOps(a, 'the quick red fox jumps');
    expect(a.text).toBe('the quick red fox jumps');
    expect(ops.length).toBeLessThan(12); // not 25 deletes + 23 inserts
  });

  it('round trips: applying diff(a, b) to a yields exactly b', () => {
    const cases: [string, string][] = [
      ['', 'hello'],
      ['hello', ''],
      ['abc', 'axc'],
      ['a document', 'a much longer document indeed'],
      ['remove middle', 'remove'],
    ];
    for (const [from, to] of cases) {
      const r = new Rga('a');
      if (from) r.localInsert(0, from);
      diffToOps(r, to);
      expect(r.text).toBe(to);
    }
  });
});

describe('snapshots', () => {
  it('round trips through a snapshot and keeps merging afterwards', () => {
    const a = new Rga('a');
    a.localInsert(0, 'persisted content');
    a.localDelete(0, 4);

    const restored = Rga.fromSnapshot('a', JSON.parse(JSON.stringify(a.snapshot())));
    expect(restored.text).toBe(a.text);

    const b = new Rga('b');
    b.applyRemote(
      a.snapshot().nodes.map((n) => ({ t: 'ins' as const, id: n.id, ch: n.ch, left: n.left })),
    );
    const bOps = b.localInsert(0, 'NEW ');
    restored.applyRemote(bOps);
    expect(restored.text.startsWith('NEW ')).toBe(true);
  });
});
