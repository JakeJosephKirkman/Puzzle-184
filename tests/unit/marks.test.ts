import { describe, expect, it } from 'vitest';
import { Rga } from '../../src/lib/crdt/rga';

describe('formatting marks', () => {
  it('resolves concurrent marks on the same range last-writer-wins', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    b.applyRemote(a.localInsert(0, 'formatted text'));

    const startA = a.idAtIndex(0)!;
    const endA = a.idAtIndex(8)!;
    const markA = a.addMark('bold', startA, endA);

    const markB: typeof markA = { ...markA, value: 'other', lamport: markA.lamport + 5, site: 'b' };

    a.applyMark(markB);
    b.applyMark(markA);
    b.applyMark(markB);

    const fromA = a.activeMarks().find((m) => m.id === markA.id);
    const fromB = b.activeMarks().find((m) => m.id === markA.id);
    expect(fromA?.value).toBe(fromB?.value);
    expect(fromA?.value).toBe('other');
  });

  it('stops rendering a mark once its anchor characters are gone', () => {
    const a = new Rga('a');
    a.localInsert(0, 'keep this bit');
    const start = a.idAtIndex(5)!;
    const end = a.idAtIndex(8)!;
    a.addMark('bold', start, end);

    expect(a.segments().some((s) => s.marks.length > 0)).toBe(true);

    a.localDelete(5, 4);
    // The mark survives as data but no longer matches any visible range.
    expect(a.segments().every((s) => s.marks.length === 0)).toBe(true);
  });

  it('splits the document into runs that share formatting', () => {
    const a = new Rga('a');
    a.localInsert(0, 'plain bold plain');
    a.addMark('bold', a.idAtIndex(6)!, a.idAtIndex(9)!);

    const segments = a.segments();
    expect(segments.map((s) => s.text).join('')).toBe('plain bold plain');
    expect(segments.find((s) => s.marks.some((m) => m.type === 'bold'))?.text).toBe('bold');
  });
});

describe('comment anchors', () => {
  it('keeps an anchor on its sentence when text is inserted above it', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    b.applyRemote(a.localInsert(0, 'first line\nthe commented sentence'));

    const startId = a.idAtIndex(11)!;
    const endId = a.idAtIndex(30)!;
    const quoted = a.text.slice(11, 31);

    // Somebody else writes a whole paragraph above the anchored text.
    a.applyRemote(b.localInsert(0, 'A NEW PARAGRAPH INSERTED ABOVE\n'));

    const from = a.indexOfId(startId);
    const to = a.indexOfId(endId);
    expect(from).toBeGreaterThan(11);
    expect(a.text.slice(from, to + 1)).toBe(quoted);
  });

  it('reports an anchor as orphaned once its range is fully deleted', () => {
    const a = new Rga('a');
    a.localInsert(0, 'delete this comment target');
    const startId = a.idAtIndex(7)!;
    const endId = a.idAtIndex(10)!;

    a.localDelete(7, 4);

    expect(a.indexOfId(startId)).toBe(-1);
    expect(a.indexOfId(endId)).toBe(-1);
  });
});
