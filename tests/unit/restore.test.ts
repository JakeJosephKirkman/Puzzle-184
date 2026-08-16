import { describe, expect, it } from 'vitest';
import { Rga } from '../../src/lib/crdt/rga';
import { opsToReachText } from '../../src/lib/crdt/diff';

/**
 * Version restore.
 *
 * Restoring is deliberately NOT an overwrite -- an overwrite is the exact
 * data-loss behaviour this project exists to prevent. It is computed as a
 * forward diff and applied as ordinary operations, which is what makes it
 * propagate to every connected client and remain undoable.
 *
 * These tests exercise the layer where that is actually decided.
 */
describe('version restore', () => {
  it('moves the document to the target text', () => {
    const doc = new Rga('a');
    doc.localInsert(0, 'Original content.');
    const savedVersion = doc.text;

    doc.localInsert(doc.length, ' Extra text that will be rolled back.');
    expect(doc.text).not.toBe(savedVersion);

    opsToReachText(doc, savedVersion);
    expect(doc.text).toBe('Original content.');
  });

  it('propagates to every other client as ordinary operations', () => {
    const alice = new Rga('alice');
    const bob = new Rga('bob');

    const seed = alice.localInsert(0, 'Original content.');
    bob.applyRemote(seed);
    const savedVersion = alice.text;

    const extra = alice.localInsert(alice.length, ' Extra text to roll back.');
    bob.applyRemote(extra);
    expect(bob.text).toBe(alice.text);

    // Alice restores. Bob receives the same operations any edit would produce.
    const restoreOps = opsToReachText(alice, savedVersion);
    bob.applyRemote(restoreOps);

    expect(alice.text).toBe('Original content.');
    expect(bob.text).toBe('Original content.');
  });

  it('is itself undoable -- the pre-restore state can be restored back', () => {
    const doc = new Rga('a');
    doc.localInsert(0, 'first draft');
    const v1 = doc.text;

    opsToReachText(doc, 'second draft, much longer');
    const v2 = doc.text;

    opsToReachText(doc, v1);
    expect(doc.text).toBe('first draft');

    // Nothing was destroyed: rolling forward again works just as well.
    opsToReachText(doc, v2);
    expect(doc.text).toBe('second draft, much longer');
  });

  it('converges when someone keeps typing during a restore', () => {
    const alice = new Rga('alice');
    const bob = new Rga('bob');
    const seed = alice.localInsert(0, 'shared paragraph');
    bob.applyRemote(seed);

    // Alice restores to an earlier text while Bob, unaware, appends.
    const restoreOps = opsToReachText(alice, 'shared');
    const bobOps = bob.localInsert(bob.length, ' plus Bob');

    alice.applyRemote(bobOps);
    bob.applyRemote(restoreOps);

    // Whatever the merged result, both replicas must agree on it and Bob's
    // concurrent work must not be silently discarded by the restore.
    expect(alice.text).toBe(bob.text);
    expect(alice.text).toContain('Bob');
  });

  it('restores an empty document without error', () => {
    const doc = new Rga('a');
    doc.localInsert(0, 'to be cleared');
    opsToReachText(doc, '');
    expect(doc.text).toBe('');
  });
});
