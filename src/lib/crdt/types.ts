/**
 * Core CRDT types.
 *
 * A `CharId` is a globally unique, totally orderable identifier for a single
 * character: `${lamport}:${siteId}`. Every character ever inserted into a
 * document keeps its id forever, even after deletion (tombstones), which is
 * what lets concurrent operations reference stable positions instead of
 * integer offsets that shift under them.
 */
export type CharId = string;

export type SiteId = string;

/** Insert `ch`, immediately to the right of `left` (null means start of document). */
export interface InsertOp {
  t: 'ins';
  id: CharId;
  ch: string;
  left: CharId | null;
}

/**
 * Tombstone the character `id`. Never a splice -- the node stays for ordering.
 *
 * Carries its own (lamport, site) because deletion is a last-writer-wins
 * register rather than a latch: undo needs to be able to revive a character,
 * so the two operations have to be orderable against each other.
 */
export interface DeleteOp {
  t: 'del';
  id: CharId;
  lamport: number;
  site: SiteId;
}

/**
 * Clear the tombstone on `id`, restoring the original character.
 *
 * This is what makes undo of a deletion possible without inventing new
 * characters -- the character ids come back unchanged, so comments anchored to
 * them stop being orphaned.
 */
export interface ReviveOp {
  t: 'rev';
  id: CharId;
  lamport: number;
  site: SiteId;
}

export type Op = InsertOp | DeleteOp | ReviveOp;

/** Formatting applied to a range, anchored to character ids rather than offsets. */
export type MarkType =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'code'
  | 'highlight'
  | 'color'
  | 'link'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bullet'
  | 'numbered';

export interface Mark {
  id: string;
  type: MarkType;
  startId: CharId;
  endId: CharId;
  value?: string;
  /** Last-writer-wins ordering for concurrent changes to the same mark. */
  lamport: number;
  site: SiteId;
  removed?: boolean;
}

export interface RgaNode {
  id: CharId;
  ch: string;
  left: CharId | null;
  deleted: boolean;
  /**
   * When the deleted flag was last written, as a (lamport, site) pair. A delete
   * or revive only takes effect if it beats this, which is what makes
   * concurrent delete-and-revive converge on every replica.
   */
  stateLamport: number;
  stateSite: SiteId;
}

export interface RgaSnapshot {
  nodes: RgaNode[];
  marks: Mark[];
  clock: number;
  /** siteId -> userId, so authorship survives operation-log pruning. */
  authors?: Record<string, string>;
}

/** A caret, expressed as "immediately after this character" (null = document start). */
export interface CrdtCursor {
  afterId: CharId | null;
}

export interface CrdtRange {
  startAfterId: CharId | null;
  endAfterId: CharId | null;
}

/** Parse a CharId into its (lamport, site) parts. */
export function parseCharId(id: CharId): { lamport: number; site: SiteId } {
  const i = id.indexOf(':');
  return { lamport: Number(id.slice(0, i)), site: id.slice(i + 1) };
}

export function makeCharId(lamport: number, site: SiteId): CharId {
  return `${lamport}:${site}`;
}

/**
 * Total order over character ids: higher Lamport wins, ties broken by site id.
 *
 * The tie-break is what makes concurrent inserts at the same position resolve
 * to the same order on every replica, regardless of arrival order.
 */
export function compareCharId(a: CharId, b: CharId): number {
  const pa = parseCharId(a);
  const pb = parseCharId(b);
  if (pa.lamport !== pb.lamport) return pa.lamport - pb.lamport;
  return pa.site < pb.site ? -1 : pa.site > pb.site ? 1 : 0;
}

/**
 * Stable dedupe key for an operation.
 *
 * Inserts are keyed by character alone -- an insert is unrepeatable. Deletes
 * and revives include their own stamp, because the same character legitimately
 * gets deleted, revived and deleted again over its lifetime, and each of those
 * is a distinct operation that must not be swallowed as a duplicate.
 */
export function opKey(op: Op): string {
  if (op.t === 'ins') return `i:${op.id}`;
  return `${op.t === 'del' ? 'd' : 'r'}:${op.id}:${op.lamport}:${op.site}`;
}

/** Total order over state changes to a single character. */
export function beatsState(
  op: { lamport: number; site: SiteId },
  node: { stateLamport: number; stateSite: SiteId },
): boolean {
  if (op.lamport !== node.stateLamport) return op.lamport > node.stateLamport;
  return op.site > node.stateSite;
}
