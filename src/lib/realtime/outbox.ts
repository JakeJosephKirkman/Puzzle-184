import type { Op } from '@/lib/crdt/types';

export interface OutboxEntry {
  opId: string;
  documentId: string;
  actorId: string;
  siteId: string;
  lamport: number;
  op: Op;
}

/**
 * A durable queue of operations that have been applied locally but not yet
 * confirmed by the database.
 *
 * This is what makes a flaky connection survivable. Operations sit here while
 * the socket is down and are flushed on reconnect; because CRDT operations
 * commute and are idempotent, flushing them late, out of order, or twice all
 * produce the same result. The queue is mirrored into localStorage so even a
 * full page reload while offline does not lose the user's typing.
 */
export class Outbox {
  private entries: OutboxEntry[] = [];
  private readonly storageKey: string;

  constructor(documentId: string, sessionId: string) {
    this.storageKey = `collabspace:outbox:${documentId}:${sessionId}`;
    this.restore();
  }

  get size(): number {
    return this.entries.length;
  }

  all(): OutboxEntry[] {
    return [...this.entries];
  }

  add(entries: OutboxEntry[]): void {
    if (entries.length === 0) return;
    this.entries.push(...entries);
    this.persist();
  }

  /** Drop entries that the database has now accepted. */
  ack(opIds: string[]): void {
    if (opIds.length === 0) return;
    const done = new Set(opIds);
    this.entries = this.entries.filter((e) => !done.has(e.opId));
    this.persist();
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }

  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      if (this.entries.length === 0) window.localStorage.removeItem(this.storageKey);
      else window.localStorage.setItem(this.storageKey, JSON.stringify(this.entries));
    } catch {
      // Storage full or blocked (private mode). The in-memory queue still works
      // for the current page; only reload-survival is lost.
    }
  }

  private restore(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (raw) this.entries = JSON.parse(raw) as OutboxEntry[];
    } catch {
      this.entries = [];
    }
  }
}
