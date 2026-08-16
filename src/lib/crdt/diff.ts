import type { Op } from './types';
import type { Rga } from './rga';

/**
 * Turn "the text used to be A, now it is B" into the smallest set of CRDT
 * operations that gets from one to the other.
 *
 * A contenteditable hands us a whole new string, but sending a whole new string
 * is exactly the overwrite semantics we are avoiding. So we find the unchanged
 * prefix and suffix and emit operations only for the part that genuinely
 * changed -- one insert per typed character, a tight delete+insert for a
 * replaced selection, a single run for a paste.
 */
export function diffToOps(rga: Rga, next: string): Op[] {
  const prev = rga.text;
  if (prev === next) return [];

  const prevChars = Array.from(prev);
  const nextChars = Array.from(next);

  let start = 0;
  const maxStart = Math.min(prevChars.length, nextChars.length);
  while (start < maxStart && prevChars[start] === nextChars[start]) start++;

  let endPrev = prevChars.length;
  let endNext = nextChars.length;
  while (endPrev > start && endNext > start && prevChars[endPrev - 1] === nextChars[endNext - 1]) {
    endPrev--;
    endNext--;
  }

  const removedCount = endPrev - start;
  const inserted = nextChars.slice(start, endNext).join('');

  const ops: Op[] = [];
  // Delete first so the insertion point is computed against the shortened text,
  // which keeps a select-and-replace to exactly N deletes plus M inserts.
  if (removedCount > 0) ops.push(...rga.localDelete(start, removedCount));
  if (inserted) ops.push(...rga.localInsert(start, inserted));
  return ops;
}

/**
 * Operations that transform the document into `target`.
 *
 * Used by version restore: rather than overwriting the row (which would be the
 * destructive behaviour this whole design rejects) a restore is applied as an
 * ordinary forward edit, so every connected client converges on it live and the
 * pre-restore state stays in history.
 */
export function opsToReachText(rga: Rga, target: string): Op[] {
  return diffToOps(rga, target);
}
