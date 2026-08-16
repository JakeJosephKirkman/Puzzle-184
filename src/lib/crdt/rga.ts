import {
  type CharId,
  type CrdtCursor,
  type Mark,
  type MarkType,
  type Op,
  type RgaNode,
  type RgaSnapshot,
  type SiteId,
  compareCharId,
  makeCharId,
  opKey,
} from './types';

/**
 * RGA -- a Replicated Growable Array over characters.
 *
 * Every keystroke becomes an operation carrying its own causal context: a
 * unique id, the id of the character it was inserted after, and a Lamport
 * timestamp. Those three facts are enough to merge any two concurrent edits
 * deterministically, which means:
 *
 *   - operations commute: applying {A, B} and {B, A} yields identical text
 *   - operations are idempotent: applying A twice is the same as applying it once
 *   - arrival order is irrelevant, so a reconnecting client can simply replay
 *
 * Together those properties remove the failure mode this project exists to
 * prevent: there is no code path where one user's save overwrites another's,
 * because nothing is ever "saved over" -- operations are merged, not replaced.
 *
 * ## Integration rule
 *
 * To insert node N after origin O, scan right from O and skip every node whose
 * id is greater than N's, then splice N in. Ids are ordered by Lamport
 * timestamp with the site id as tie-break, so two replicas inserting at the
 * same position independently still converge on the same order.
 *
 * This works because any node causally descended from a node C has a strictly
 * greater timestamp than C (you cannot insert after something you have not
 * seen), and any node that follows O's subtree has a strictly smaller
 * timestamp than N. So the scan stops in exactly the right place on every
 * replica.
 */
export class Rga {
  readonly site: SiteId;

  /** Document order, tombstones included. Tombstones are never removed. */
  private order: RgaNode[] = [];
  private byId = new Map<CharId, RgaNode>();
  private posMap = new Map<CharId, number>();
  private posDirty = true;

  /** Operations already applied, for idempotency across duplicate delivery. */
  private seen = new Set<string>();

  /** Operations whose causal dependency has not arrived yet, keyed by that dependency. */
  private pending = new Map<CharId, Op[]>();

  private marks = new Map<string, Mark>();

  private clock = 0;
  private textCache: string | null = null;

  constructor(site: SiteId) {
    this.site = site;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** The visible document text, tombstones excluded. */
  get text(): string {
    if (this.textCache === null) {
      let out = '';
      for (const n of this.order) if (!n.deleted) out += n.ch;
      this.textCache = out;
    }
    return this.textCache;
  }

  get length(): number {
    return this.text.length;
  }

  get lamport(): number {
    return this.clock;
  }

  /** Visible characters in order, for position mapping and rendering. */
  visibleNodes(): RgaNode[] {
    return this.order.filter((n) => !n.deleted);
  }

  /** Number of operations still buffered awaiting a missing dependency. */
  get pendingCount(): number {
    let n = 0;
    for (const ops of this.pending.values()) n += ops.length;
    return n;
  }

  // -------------------------------------------------------------------------
  // Position mapping
  //
  // Cursors, selections and comment anchors are stored as CharIds, never as
  // integer offsets -- an offset is wrong the moment somebody edits above it.
  // -------------------------------------------------------------------------

  /** Visible index of a character, or -1 if unknown or deleted. */
  indexOfId(id: CharId): number {
    const target = this.byId.get(id);
    if (!target || target.deleted) return -1;
    let visible = 0;
    for (const n of this.order) {
      if (n === target) return visible;
      if (!n.deleted) visible++;
    }
    return -1;
  }

  /** Id of the visible character at `index`, or null if out of range. */
  idAtIndex(index: number): CharId | null {
    if (index < 0) return null;
    let visible = 0;
    for (const n of this.order) {
      if (n.deleted) continue;
      if (visible === index) return n.id;
      visible++;
    }
    return null;
  }

  /** Id of the character immediately left of a caret at `index` (null at start). */
  leftIdForIndex(index: number): CharId | null {
    return index <= 0 ? null : this.idAtIndex(index - 1);
  }

  /** Convert a caret offset into a stable, edit-proof cursor. */
  cursorFromIndex(index: number): CrdtCursor {
    return { afterId: this.leftIdForIndex(index) };
  }

  /**
   * Resolve a stable cursor back to a caret offset.
   *
   * If the anchor character has since been deleted by someone else, walk left
   * through the tombstones to the nearest surviving character rather than
   * throwing or snapping to the start of the document.
   */
  indexFromCursor(cursor: CrdtCursor): number {
    if (cursor.afterId === null) return 0;
    const node = this.byId.get(cursor.afterId);
    if (!node) return 0;

    this.ensurePositions();
    const pos = this.posMap.get(cursor.afterId);
    if (pos === undefined) return 0;

    let visible = 0;
    for (let i = 0; i < pos; i++) if (!this.order[i].deleted) visible++;
    return node.deleted ? visible : visible + 1;
  }

  // -------------------------------------------------------------------------
  // Local edits -- produce operations to broadcast
  // -------------------------------------------------------------------------

  /** Insert `text` at a visible offset. Returns the operations to broadcast. */
  localInsert(index: number, text: string): Op[] {
    if (!text) return [];
    const ops: Op[] = [];
    let left = this.leftIdForIndex(index);

    for (const ch of Array.from(text)) {
      this.clock += 1;
      const id = makeCharId(this.clock, this.site);
      const op: Op = { t: 'ins', id, ch, left };
      this.applyOne(op);
      ops.push(op);
      left = id;
    }
    return ops;
  }

  /** Tombstone `count` visible characters starting at `index`. */
  localDelete(index: number, count: number): Op[] {
    if (count <= 0) return [];
    const ids: CharId[] = [];
    let visible = 0;

    for (const n of this.order) {
      if (n.deleted) continue;
      if (visible >= index && visible < index + count) ids.push(n.id);
      visible++;
      if (visible >= index + count) break;
    }

    const ops: Op[] = [];
    for (const id of ids) {
      this.clock += 1;
      const op: Op = { t: 'del', id };
      this.applyOne(op);
      ops.push(op);
    }
    return ops;
  }

  // -------------------------------------------------------------------------
  // Remote edits
  // -------------------------------------------------------------------------

  /**
   * Apply operations from another replica.
   *
   * Safe to call with duplicates, with operations already applied locally, and
   * with operations in any order whatsoever -- which is precisely why an
   * offline client can just replay its backlog on reconnect.
   */
  applyRemote(ops: Op[]): Op[] {
    const applied: Op[] = [];
    for (const op of ops) {
      if (this.applyOne(op)) applied.push(op);
    }
    return applied;
  }

  /** Returns true if the operation changed state (false if duplicate or buffered). */
  private applyOne(op: Op): boolean {
    const key = opKey(op);
    if (this.seen.has(key)) return false;

    if (op.t === 'ins') {
      // Causality: an insert cannot be placed until its origin has arrived.
      if (op.left !== null && !this.byId.has(op.left)) {
        this.buffer(op.left, op);
        return false;
      }
      if (this.byId.has(op.id)) {
        this.seen.add(key);
        return false;
      }

      this.observeClock(op.id);
      const node: RgaNode = { id: op.id, ch: op.ch, left: op.left, deleted: false };
      this.integrate(node);
      this.seen.add(key);
      this.invalidate();
      this.releasePending(op.id);
      return true;
    }

    const target = this.byId.get(op.id);
    if (!target) {
      this.buffer(op.id, op);
      return false;
    }

    this.seen.add(key);
    if (target.deleted) return false; // tombstoning twice is a no-op
    target.deleted = true;
    this.invalidate();
    return true;
  }

  /** Splice a node into document order using the RGA integration rule. */
  private integrate(node: RgaNode): void {
    this.ensurePositions();

    const leftPos = node.left === null ? -1 : (this.posMap.get(node.left) ?? -1);
    let i = leftPos + 1;

    // Skip nodes with a greater id: concurrent inserts that sort before this
    // one, plus everything causally descended from them.
    while (i < this.order.length && compareCharId(this.order[i].id, node.id) > 0) {
      i++;
    }

    this.order.splice(i, 0, node);
    this.byId.set(node.id, node);
    this.posDirty = true;
  }

  private buffer(dep: CharId, op: Op): void {
    const list = this.pending.get(dep);
    if (list) list.push(op);
    else this.pending.set(dep, [op]);
  }

  /** A dependency arrived -- retry anything that was waiting on it, transitively. */
  private releasePending(id: CharId): void {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    for (const op of waiting) this.applyOne(op);
  }

  private observeClock(id: CharId): void {
    const lamport = Number(id.slice(0, id.indexOf(':')));
    if (lamport > this.clock) this.clock = lamport;
  }

  /** Bump the clock past a peer's, so ids stay causally ordered. */
  observeLamport(lamport: number): void {
    if (lamport > this.clock) this.clock = lamport;
  }

  private invalidate(): void {
    this.textCache = null;
  }

  private ensurePositions(): void {
    if (!this.posDirty) return;
    this.posMap.clear();
    for (let i = 0; i < this.order.length; i++) {
      this.posMap.set(this.order[i].id, i);
    }
    this.posDirty = false;
  }

  // -------------------------------------------------------------------------
  // Marks (formatting)
  //
  // Kept deliberately separate from the character sequence: the sequence stays
  // plain text and provably convergent, while formatting resolves by
  // last-writer-wins on (lamport, site).
  // -------------------------------------------------------------------------

  addMark(type: MarkType, startId: CharId, endId: CharId, value?: string): Mark {
    this.clock += 1;
    const mark: Mark = {
      id: `${this.clock}:${this.site}:${type}`,
      type,
      startId,
      endId,
      value,
      lamport: this.clock,
      site: this.site,
    };
    this.marks.set(mark.id, mark);
    return mark;
  }

  removeMark(markId: string): Mark | null {
    const existing = this.marks.get(markId);
    if (!existing) return null;
    this.clock += 1;
    const tombstoned: Mark = { ...existing, removed: true, lamport: this.clock, site: this.site };
    this.marks.set(markId, tombstoned);
    return tombstoned;
  }

  /** Merge a mark from another replica, last writer wins. */
  applyMark(mark: Mark): boolean {
    const existing = this.marks.get(mark.id);
    if (existing) {
      const newer =
        mark.lamport > existing.lamport ||
        (mark.lamport === existing.lamport && mark.site > existing.site);
      if (!newer) return false;
    }
    this.observeLamport(mark.lamport);
    this.marks.set(mark.id, mark);
    return true;
  }

  activeMarks(): Mark[] {
    return [...this.marks.values()].filter((m) => !m.removed);
  }

  /**
   * Visible text split into runs sharing the same formatting, for rendering.
   * Marks whose range has been entirely deleted simply stop matching.
   */
  segments(): { text: string; marks: Mark[]; startId: CharId | null }[] {
    const visible = this.visibleNodes();
    if (visible.length === 0) return [];

    this.ensurePositions();
    const ranges = this.activeMarks()
      .map((m) => ({
        mark: m,
        from: this.posMap.get(m.startId),
        to: this.posMap.get(m.endId),
      }))
      .filter(
        (r): r is { mark: Mark; from: number; to: number } =>
          r.from !== undefined && r.to !== undefined,
      );

    const out: { text: string; marks: Mark[]; startId: CharId | null }[] = [];
    let current: { text: string; marks: Mark[]; startId: CharId | null } | null = null;
    let signature = '';

    for (const node of visible) {
      const pos = this.posMap.get(node.id) ?? -1;
      const active = ranges
        .filter((r) => pos >= Math.min(r.from, r.to) && pos <= Math.max(r.from, r.to))
        .map((r) => r.mark);
      const sig = active
        .map((m) => `${m.type}:${m.value ?? ''}`)
        .sort()
        .join('|');

      if (current && sig === signature) {
        current.text += node.ch;
      } else {
        if (current) out.push(current);
        current = { text: node.ch, marks: active, startId: node.id };
        signature = sig;
      }
    }
    if (current) out.push(current);
    return out;
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  snapshot(): RgaSnapshot {
    return {
      nodes: this.order.map((n) => ({ ...n })),
      marks: [...this.marks.values()],
      clock: this.clock,
    };
  }

  static fromSnapshot(site: SiteId, snapshot: RgaSnapshot): Rga {
    const rga = new Rga(site);
    rga.order = snapshot.nodes.map((n) => ({ ...n }));
    for (const n of rga.order) {
      rga.byId.set(n.id, n);
      rga.seen.add(`i:${n.id}`);
      if (n.deleted) rga.seen.add(`d:${n.id}`);
    }
    for (const m of snapshot.marks ?? []) rga.marks.set(m.id, m);
    rga.clock = snapshot.clock ?? 0;
    rga.posDirty = true;
    rga.invalidate();
    return rga;
  }
}
