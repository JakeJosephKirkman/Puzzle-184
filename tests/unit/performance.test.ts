import { describe, expect, it } from 'vitest';
import { Rga } from '../../src/lib/crdt/rga';

/**
 * Guards against the position lookups going back to a linear scan.
 *
 * These are not micro-benchmarks -- the budgets are deliberately loose so they
 * do not flake on a slow machine. They are there to catch an algorithmic
 * regression: with an O(n) scan per lookup these take seconds, not
 * milliseconds, and the failure is unmistakable rather than marginal.
 */

function documentOf(chars: number): Rga {
  const rga = new Rga('perf');
  rga.localInsert(0, 'x'.repeat(chars));
  return rga;
}

describe('position lookup performance', () => {
  it('resolves every character position in a 20k document quickly', () => {
    // This is the authorship heatmap's access pattern: one lookup per
    // character. As a linear scan it is 400 million steps.
    const rga = documentOf(20_000);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) rga.idAtIndex(i);
    const elapsed = performance.now() - started;

    expect(rga.idAtIndex(19_999)).not.toBeNull();
    expect(elapsed).toBeLessThan(500);
  });

  it('resolves ids back to indexes quickly', () => {
    const rga = documentOf(20_000);
    const ids = Array.from({ length: 20_000 }, (_, i) => rga.idAtIndex(i)!);

    const started = performance.now();
    for (const id of ids) rga.indexOfId(id);
    const elapsed = performance.now() - started;

    expect(rga.indexOfId(ids[19_999])).toBe(19_999);
    expect(elapsed).toBeLessThan(500);
  });

  it('stays fast when the document is mostly tombstones', () => {
    // Deleted characters are never collected, so an old document has far more
    // nodes than visible text. Lookups must scale with what is visible.
    const rga = documentOf(20_000);
    rga.localDelete(0, 19_000);
    expect(rga.length).toBe(1_000);

    const started = performance.now();
    for (let i = 0; i < 1_000; i++) rga.idAtIndex(i);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(200);
  });

  it('keeps the index correct after edits invalidate it', () => {
    // The cache is only safe if every mutation drops it.
    const rga = new Rga('a');
    rga.localInsert(0, 'abcdef');
    expect(rga.idAtIndex(2)).toBe(rga.idAtIndex(2));
    const cId = rga.idAtIndex(2)!;
    expect(rga.indexOfId(cId)).toBe(2);

    rga.localInsert(0, 'XY');
    expect(rga.indexOfId(cId)).toBe(4);
    expect(rga.text[4]).toBe('c');

    rga.localDelete(0, 2);
    expect(rga.indexOfId(cId)).toBe(2);

    const revived = rga.localDelete(2, 1);
    expect(rga.indexOfId(cId)).toBe(-1);
    rga.localRevive(revived.map((o) => o.id));
    expect(rga.indexOfId(cId)).toBe(2);
  });
});

describe('bulk insert performance', () => {
  it('pastes a large document without stalling', () => {
    // The chained-insert path. Before it existed, every character rebuilt the
    // whole position map, so this took ~35 seconds -- long enough to look like
    // the browser had hung.
    const rga = new Rga('paste');
    const started = performance.now();
    rga.localInsert(0, 'lorem ipsum dolor sit amet '.repeat(1_000));
    const elapsed = performance.now() - started;

    expect(rga.length).toBe(27_000);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('applies a large remote batch without stalling', () => {
    // A peer's paste arrives as a run of chained inserts, and must be as cheap
    // to receive as it was to produce.
    const source = new Rga('source');
    const ops = source.localInsert(0, 'remote paste content '.repeat(500));

    const receiver = new Rga('receiver');
    const started = performance.now();
    receiver.applyRemote(ops);
    const elapsed = performance.now() - started;

    expect(receiver.text).toBe(source.text);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('still converges when a chained batch is interleaved with another edit', () => {
    // The fast path assumes each insert chains from the last. Anything that
    // breaks the chain must fall back to a real lookup rather than guessing.
    const a = new Rga('a');
    const b = new Rga('b');
    const seed = a.localInsert(0, 'base text');
    b.applyRemote(seed);

    const paste = a.localInsert(4, 'X'.repeat(200));
    const other = b.localInsert(0, 'PREFIX ');

    a.applyRemote(other);
    // Deliver the paste out of order, so the chain is broken on arrival.
    b.applyRemote([...paste].reverse());

    expect(a.text).toBe(b.text);
    expect(a.text).toContain('PREFIX');
    expect(a.text).toContain('X'.repeat(200));
  });
});
