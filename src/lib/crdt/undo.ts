import type { Op, SiteId } from './types';

/**
 * Undo history for a single session.
 *
 * The important property is what this class *cannot* do. It only ever records
 * operations produced locally, so undo is selective by construction: there is
 * no code path by which it could revert a collaborator's edit. That matters
 * more here than in a single-player editor -- in a shared document, an undo
 * that reaches into someone else's work is indistinguishable from data loss,
 * which is the exact failure this project exists to prevent.
 *
 * Before this existed, Cmd+Z fell through to the browser's native
 * contentEditable undo, which rewrote the DOM behind the CRDT's back and was
 * then diffed as if the user had typed it -- operating on the *merged* text,
 * and so capable of reverting anyone's edits.
 */

/** Operations are grouped so undo removes a word, not a single letter. */
const TRANSACTION_IDLE_MS = 500;

interface Transaction {
  ops: Op[];
  at: number;
}

export class UndoStack {
  private undoable: Transaction[] = [];
  private redoable: Transaction[] = [];
  private lastPush = 0;

  constructor(
    private readonly site: SiteId,
    private readonly limit = 200,
  ) {}

  get canUndo(): boolean {
    return this.undoable.length > 0;
  }

  get canRedo(): boolean {
    return this.redoable.length > 0;
  }

  /**
   * Record locally-produced operations.
   *
   * Operations from any other site are ignored rather than trusted, so even a
   * mistaken caller cannot make someone else's work undoable from here.
   */
  record(ops: Op[], now = Date.now()): void {
    const mine = ops.filter((op) => this.siteOf(op) === this.site);
    if (mine.length === 0) return;

    const head = this.undoable[this.undoable.length - 1];
    if (head && now - this.lastPush <= TRANSACTION_IDLE_MS) {
      head.ops.push(...mine);
    } else {
      this.undoable.push({ ops: mine, at: now });
      if (this.undoable.length > this.limit) this.undoable.shift();
    }
    this.lastPush = now;

    // Typing after an undo abandons the redo branch, as in any editor.
    this.redoable = [];
  }

  /** The operations of the most recent transaction, to be inverted and applied. */
  popUndo(): Op[] | null {
    const tx = this.undoable.pop();
    if (!tx) return null;
    this.redoable.push(tx);
    this.lastPush = 0; // the next edit starts a fresh transaction
    return tx.ops;
  }

  popRedo(): Op[] | null {
    const tx = this.redoable.pop();
    if (!tx) return null;
    this.undoable.push(tx);
    this.lastPush = 0;
    return tx.ops;
  }

  clear(): void {
    this.undoable = [];
    this.redoable = [];
  }

  private siteOf(op: Op): SiteId {
    if (op.t === 'ins') return op.id.slice(op.id.indexOf(':') + 1);
    return op.site;
  }
}

/**
 * Split a transaction into the ids to revive and the ids to tombstone.
 *
 * Inverting an insert tombstones that character; inverting a delete revives it.
 * The caller issues fresh operations with new Lamport stamps, so an undo merges
 * exactly like any other edit rather than rewriting history.
 */
export function invertTransaction(ops: Op[]): { revive: string[]; remove: string[] } {
  const revive: string[] = [];
  const remove: string[] = [];

  // Reverse order so a delete-then-reinsert sequence unwinds correctly.
  for (const op of [...ops].reverse()) {
    if (op.t === 'ins') remove.push(op.id);
    else if (op.t === 'del') revive.push(op.id);
    else remove.push(op.id); // undoing a revive means deleting again
  }
  return { revive, remove };
}

/**
 * The same split, in the forward direction, for redo.
 *
 * Redo re-applies a transaction's original intent: characters it inserted were
 * tombstoned by the undo and must come back, characters it deleted must go
 * again.
 */
export function forwardTransaction(ops: Op[]): { revive: string[]; remove: string[] } {
  const revive: string[] = [];
  const remove: string[] = [];
  for (const op of ops) {
    if (op.t === 'ins' || op.t === 'rev') revive.push(op.id);
    else remove.push(op.id);
  }
  return { revive, remove };
}
