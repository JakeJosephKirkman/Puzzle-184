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

/** Tombstone the character `id`. Never a splice -- the node stays for ordering. */
export interface DeleteOp {
  t: 'del';
  id: CharId;
}

export type Op = InsertOp | DeleteOp;

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
}

export interface RgaSnapshot {
  nodes: RgaNode[];
  marks: Mark[];
  clock: number;
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

/** Stable dedupe key for an operation. Deleting the same char twice is one op. */
export function opKey(op: Op): string {
  return op.t === 'ins' ? `i:${op.id}` : `d:${op.id}`;
}
