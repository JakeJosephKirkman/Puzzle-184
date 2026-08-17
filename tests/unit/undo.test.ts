import { describe, expect, it } from 'vitest';
import { Rga } from '../../src/lib/crdt/rga';
import { UndoStack, invertTransaction } from '../../src/lib/crdt/undo';
import type { Op } from '../../src/lib/crdt/types';

/** Apply an inverted transaction the way the hook does. */
function undoOnce(rga: Rga, stack: UndoStack): Op[] {
  const tx = stack.popUndo();
  if (!tx) return [];
  const { revive, remove } = invertTransaction(tx);
  const ops: Op[] = [];
  ops.push(...rga.localRevive(revive));
  for (const id of remove) {
    const index = rga.indexOfId(id);
    if (index >= 0) ops.push(...rga.localDelete(index, 1));
  }
  return ops;
}

describe('selective undo', () => {
  it('NEVER reverts another user\'s edit', () => {
    // The property that matters most. In a shared document an undo that reaches
    // into somebody else's work is indistinguishable from data loss.
    const alice = new Rga('alice');
    const bob = new Rga('bob');
    const stack = new UndoStack('alice');

    const seed = alice.localInsert(0, 'Shared. ');
    stack.record(seed, 1000);
    bob.applyRemote(seed);

    const aliceOps = alice.localInsert(alice.length, 'alice typed this');
    stack.record(aliceOps, 3000);
    bob.applyRemote(aliceOps);

    // Bob's edit arrives INSIDE Alice's transaction window (500ms), so if the
    // stack were not filtering by site it would fold his operations into the
    // same undo step and revert them along with hers. Recording it 1s later
    // would open a new transaction and the bug would hide.
    const bobOps = bob.localInsert(bob.length, ' BOB WAS HERE.');
    alice.applyRemote(bobOps);
    stack.record(bobOps, 3100);

    const undoOps = undoOnce(alice, stack);
    bob.applyRemote(undoOps);

    expect(alice.text).toContain('BOB WAS HERE.');
    expect(alice.text).not.toContain('alice typed this');
    expect(bob.text).toBe(alice.text);
  });

  it('ignores operations from other sites even if handed them directly', () => {
    const stack = new UndoStack('mine');
    const other = new Rga('theirs');
    stack.record(other.localInsert(0, 'not mine'), 1000);
    expect(stack.canUndo).toBe(false);
  });
});

describe('undo of a deletion', () => {
  it('restores the ORIGINAL characters, so anchors reattach', () => {
    // Re-inserting the same text as new characters would look identical on
    // screen while silently orphaning every comment anchored to it.
    const doc = new Rga('a');
    const stack = new UndoStack('a');
    stack.record(doc.localInsert(0, 'keep the commented words'), 1000);

    const anchorStart = doc.idAtIndex(9)!;
    const anchorEnd = doc.idAtIndex(17)!;
    expect(doc.text.slice(9, 18)).toBe('commented');

    stack.record(doc.localDelete(9, 9), 2000);
    expect(doc.text).toBe('keep the  words');
    expect(doc.indexOfId(anchorStart)).toBe(-1); // orphaned while deleted

    undoOnce(doc, stack);

    expect(doc.text).toBe('keep the commented words');
    // Same ids, so the comment is anchored again rather than lost.
    expect(doc.indexOfId(anchorStart)).toBe(9);
    expect(doc.indexOfId(anchorEnd)).toBe(17);
  });

  it('propagates a revive to other replicas', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const stack = new UndoStack('a');

    const seed = a.localInsert(0, 'hello world');
    stack.record(seed, 1000);
    b.applyRemote(seed);

    const del = a.localDelete(5, 6);
    stack.record(del, 2000);
    b.applyRemote(del);
    expect(b.text).toBe('hello');

    const undoOps = undoOnce(a, stack);
    b.applyRemote(undoOps);

    expect(a.text).toBe('hello world');
    expect(b.text).toBe('hello world');
  });
});

describe('delete and revive convergence', () => {
  it('converges however the two arrive', () => {
    const build = () => {
      const r = new Rga('seed');
      r.localInsert(0, 'abcdef');
      return r;
    };
    const base = build().snapshot();

    const first = Rga.fromSnapshot('x', JSON.parse(JSON.stringify(base)));
    const second = Rga.fromSnapshot('y', JSON.parse(JSON.stringify(base)));

    const target = first.idAtIndex(2)!;
    const del = first.localDelete(2, 1);
    const rev = second.localRevive([target]); // concurrent, unaware of the delete

    first.applyRemote(rev);
    second.applyRemote(del);

    expect(first.text).toBe(second.text);
  });

  it('a later revive beats an earlier delete', () => {
    const doc = new Rga('a');
    doc.localInsert(0, 'abc');
    const id = doc.idAtIndex(1)!;

    doc.localDelete(1, 1);
    expect(doc.text).toBe('ac');

    doc.localRevive([id]);
    expect(doc.text).toBe('abc');

    doc.localDelete(1, 1);
    expect(doc.text).toBe('ac'); // and delete again beats that revive
  });
});

describe('undo stack behaviour', () => {
  it('groups a burst of typing into one step', () => {
    const doc = new Rga('a');
    const stack = new UndoStack('a');

    stack.record(doc.localInsert(0, 'hello'), 1000);
    stack.record(doc.localInsert(5, ' there'), 1200); // within the idle window

    undoOnce(doc, stack);
    expect(doc.text).toBe(''); // one step removed both
    expect(stack.canUndo).toBe(false);
  });

  it('starts a new step after a pause', () => {
    const doc = new Rga('a');
    const stack = new UndoStack('a');

    stack.record(doc.localInsert(0, 'first'), 1000);
    stack.record(doc.localInsert(5, ' second'), 5000); // long after

    undoOnce(doc, stack);
    expect(doc.text).toBe('first');
    expect(stack.canUndo).toBe(true);
  });

  it('redoes what was undone, and typing abandons the redo branch', () => {
    const doc = new Rga('a');
    const stack = new UndoStack('a');
    stack.record(doc.localInsert(0, 'typed'), 1000);

    undoOnce(doc, stack);
    expect(doc.text).toBe('');
    expect(stack.canRedo).toBe(true);

    const redo = stack.popRedo();
    expect(redo).not.toBeNull();
    doc.localRevive(redo!.filter((o) => o.t === 'ins').map((o) => o.id));
    expect(doc.text).toBe('typed');

    stack.record(doc.localInsert(doc.length, '!'), 9000);
    expect(stack.canRedo).toBe(false);
  });

  it('reports nothing to undo on an untouched document', () => {
    const stack = new UndoStack('a');
    expect(stack.canUndo).toBe(false);
    expect(stack.popUndo()).toBeNull();
  });
});
