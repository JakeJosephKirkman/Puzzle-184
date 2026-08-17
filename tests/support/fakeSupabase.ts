/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * An in-memory stand-in for the slice of supabase-js this app uses.
 *
 * The collaboration hook is the largest untested surface in the project, and it
 * was untested only because it talks to Supabase. This double closes that gap:
 * two hook instances share one broker, which is the two-tab scenario without a
 * WebSocket.
 *
 * It models the behaviours the hook actually depends on for correctness:
 *
 *   - `upsert` with `ignoreDuplicates` on a unique key, because that is what
 *     makes outbox replay idempotent
 *   - `postgres_changes` fan-out with filter matching, so an operation can
 *     legitimately arrive over BOTH transports and the dedupe path is exercised
 *   - broadcast honouring `{ self: false }`
 *   - `collab_save_snapshot` enforcing expected_version and raising a
 *     40001-shaped error, so the conflict-retry path runs for real
 *
 * What it does NOT model: real WebSocket transport, heartbeat eviction timing,
 * or Postgres Changes latency. Those belong to the Playwright suite.
 */

type Row = Record<string, any>;

interface ChangeListener {
  event: string;
  table: string;
  filter?: string;
  cb: (payload: { eventType: string; new: Row; old: Row }) => void;
}

let seqCounter = 0;

export class FakeBroker {
  tables = new Map<string, Row[]>();
  private channels: FakeChannel[] = [];

  /**
   * Delivery can be held so two clients genuinely edit without having seen each
   * other -- the Alice-and-Bob case. Without this, anything sent synchronously
   * arrives before the second client acts, which makes the edit sequential and
   * tests nothing about merging.
   */
  private paused = false;
  private queue: (() => void)[] = [];

  pause() { this.paused = true; }

  resume() {
    this.paused = false;
    const pending = this.queue;
    this.queue = [];
    for (const fn of pending) fn();
  }

  private deliver(fn: () => void) {
    if (this.paused) this.queue.push(fn);
    else fn();
  }

  users = new Map<string, Row>();
  authListeners: ((event: string, session: { user: Row } | null) => void)[] = [];

  currentUser(id: string): Row {
    if (!this.users.has(id)) this.users.set(id, { id, is_anonymous: true, email: null });
    return this.users.get(id)!;
  }

  /** Whether some *other* user already owns this email. */
  emailOwner(email: string, exceptId: string | null): boolean {
    for (const [id, user] of this.users) {
      if (id !== exceptId && user.email === email) return true;
    }
    return false;
  }

  emitAuthChange(user: Row) {
    for (const cb of this.authListeners) cb('USER_UPDATED', { user });
  }

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  register(channel: FakeChannel) {
    this.channels.push(channel);
  }

  unregister(channel: FakeChannel) {
    this.channels = this.channels.filter((c) => c !== channel);
  }

  peersOf(topic: string): FakeChannel[] {
    return this.channels.filter((c) => c.topic === topic && c.joined);
  }

  /** Fan a broadcast out to every other subscriber on the topic. */
  broadcast(from: FakeChannel, event: string, payload: unknown) {
    for (const c of this.peersOf(from.topic)) {
      if (c === from) continue; // { self: false }
      this.deliver(() => c.emitBroadcast(event, payload));
    }
  }

  /** Emit a postgres_changes event to every listener whose filter matches. */
  emitChange(table: string, eventType: string, row: Row, old: Row = {}) {
    for (const c of this.channels) {
      for (const l of c.changeListeners) {
        if (l.table !== table) continue;
        if (l.event !== '*' && l.event !== eventType) continue;
        if (l.filter) {
          const [col, rest] = l.filter.split('=eq.');
          if (String(row[col]) !== rest) continue;
        }
        const fire = l.cb;
        this.deliver(() => fire({ eventType, new: row, old }));
      }
    }
  }

  syncPresence(topic: string) {
    for (const c of this.peersOf(topic)) c.emitPresenceSync();
  }

  /** Simulate a tab dying without saying goodbye. */
  disconnect(sessionId: string) {
    const dying = this.channels.filter((c) => c.presenceKey === sessionId);
    for (const c of dying) {
      const left = c.tracked ? [c.tracked] : [];
      c.joined = false;
      const topic = c.topic;
      this.unregister(c);
      for (const peer of this.peersOf(topic)) {
        peer.emitPresenceLeave(left);
        peer.emitPresenceSync();
      }
    }
  }
}

export class FakeChannel {
  joined = false;
  tracked: Row | null = null;
  changeListeners: ChangeListener[] = [];
  private broadcastListeners = new Map<string, ((p: { payload: unknown }) => void)[]>();
  private presenceListeners = new Map<string, ((p: any) => void)[]>();

  constructor(
    readonly topic: string,
    readonly presenceKey: string,
    private broker: FakeBroker,
  ) {
    broker.register(this);
  }

  on(type: string, opts: any, cb?: any) {
    if (type === 'presence') {
      const list = this.presenceListeners.get(opts.event) ?? [];
      list.push(cb);
      this.presenceListeners.set(opts.event, list);
    } else if (type === 'broadcast') {
      const list = this.broadcastListeners.get(opts.event) ?? [];
      list.push(cb);
      this.broadcastListeners.set(opts.event, list);
    } else if (type === 'postgres_changes') {
      this.changeListeners.push({
        event: opts.event,
        table: opts.table,
        filter: opts.filter,
        cb,
      });
    }
    return this;
  }

  subscribe(cb?: (status: string) => void) {
    this.joined = true;
    void Promise.resolve().then(() => cb?.('SUBSCRIBED'));
    return this;
  }

  async track(state: Row) {
    this.tracked = state;
    this.broker.syncPresence(this.topic);
    return 'ok';
  }

  async untrack() {
    this.tracked = null;
    this.broker.syncPresence(this.topic);
    return 'ok';
  }

  async send({ event, payload }: { type: string; event: string; payload: unknown }) {
    this.broker.broadcast(this, event, payload);
    return 'ok';
  }

  presenceState() {
    const out: Record<string, Row[]> = {};
    for (const c of this.broker.peersOf(this.topic)) {
      if (c.tracked) out[c.presenceKey] = [c.tracked];
    }
    return out;
  }

  emitBroadcast(event: string, payload: unknown) {
    for (const cb of this.broadcastListeners.get(event) ?? []) cb({ payload });
  }

  emitPresenceSync() {
    for (const cb of this.presenceListeners.get('sync') ?? []) cb({});
  }

  emitPresenceLeave(leftPresences: Row[]) {
    for (const cb of this.presenceListeners.get('leave') ?? []) cb({ leftPresences });
  }
}

/** Chainable, awaitable query builder over the in-memory tables. */
class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private limitN: number | null = null;

  constructor(
    private broker: FakeBroker,
    private table: string,
    private pending: { kind: string; rows?: Row[]; patch?: Row; opts?: any } = { kind: 'select' },
  ) {}

  select() { return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => String(r[col]) === String(val)); return this; }
  gt(col: string, val: number) { this.filters.push((r) => Number(r[col]) > Number(val)); return this; }
  in(col: string, vals: unknown[]) { this.filters.push((r) => vals.map(String).includes(String(r[col]))); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, asc: opts?.ascending !== false }; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private matching(): Row[] {
    let rows = this.broker.rows(this.table).filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows = [...rows].sort((a, b) => {
        const x = a[col], y = b[col];
        const cmp = x === y ? 0 : x > y ? 1 : -1;
        return asc ? cmp : -cmp;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  private run(): { data: any; error: any } {
    const store = this.broker.rows(this.table);

    if (this.pending.kind === 'insert' || this.pending.kind === 'upsert') {
      const inserted: Row[] = [];
      for (const raw of this.pending.rows ?? []) {
        const row = { ...raw };
        if (row.id === undefined) row.id = `${this.table}-${Math.random().toString(36).slice(2)}`;
        if (this.table === 'collab_operations') row.seq = ++seqCounter;
        row.created_at ??= new Date().toISOString();

        if (this.pending.kind === 'upsert' && this.pending.opts?.onConflict) {
          const keys = String(this.pending.opts.onConflict).split(',').map((k) => k.trim());
          const clash = store.find((r) => keys.every((k) => String(r[k]) === String(row[k])));
          if (clash) continue; // ignoreDuplicates -- what makes replay safe
        }
        store.push(row);
        inserted.push(row);
        this.broker.emitChange(this.table, 'INSERT', row);
      }
      return { data: inserted, error: null };
    }

    if (this.pending.kind === 'update') {
      const updated: Row[] = [];
      for (const row of this.matching()) {
        Object.assign(row, this.pending.patch);
        updated.push(row);
        this.broker.emitChange(this.table, 'UPDATE', row);
      }
      return { data: updated, error: null };
    }

    return { data: this.matching(), error: null };
  }

  insert(rows: Row | Row[]) {
    this.pending = { kind: 'insert', rows: Array.isArray(rows) ? rows : [rows] };
    return this;
  }
  upsert(rows: Row | Row[], opts?: any) {
    this.pending = { kind: 'upsert', rows: Array.isArray(rows) ? rows : [rows], opts };
    return this;
  }
  update(patch: Row) {
    this.pending = { kind: 'update', patch };
    return this;
  }

  single() { const { data, error } = this.run(); return Promise.resolve({ data: (data ?? [])[0] ?? null, error }); }
  maybeSingle() { return this.single(); }

  then(res: any, rej?: any) {
    const out = this.run();
    return Promise.resolve(Array.isArray(out.data) ? out : out).then(res, rej);
  }
}

export function createFakeSupabase(broker: FakeBroker, userId = 'user-1') {
  return {
    __broker: broker,
    auth: {
      async getUser() { return { data: { user: broker.currentUser(userId) } }; },
      async signInAnonymously() {
        return { data: { user: broker.currentUser(userId) }, error: null };
      },

      /**
       * Attaching an email must NOT mint a new user -- the whole feature rests
       * on the id surviving, so the double models that precisely rather than
       * returning a convenient stub.
       */
      async updateUser({ email }: { email: string }) {
        if (broker.emailOwner(email, userId)) {
          return { data: null, error: { message: 'Email address already registered' } };
        }
        const user = broker.currentUser(userId);
        user.email = email;
        user.is_anonymous = true; // still anonymous until the link is followed
        return { data: { user }, error: null };
      },

      async signInWithOtp({ email }: { email: string }) {
        if (!broker.emailOwner(email, null)) {
          return { data: null, error: { message: 'Invalid email or user not found' } };
        }
        return { data: {}, error: null };
      },

      /** Simulates the emailed link being followed. */
      async verifyOtp() {
        const user = broker.currentUser(userId);
        user.is_anonymous = false;
        broker.emitAuthChange(user);
        return { data: { user }, error: null };
      },

      async signOut() {
        broker.users.delete(userId);
        return { error: null };
      },

      onAuthStateChange(cb: (event: string, session: { user: Row } | null) => void) {
        broker.authListeners.push(cb);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                broker.authListeners = broker.authListeners.filter((l) => l !== cb);
              },
            },
          },
        };
      },
    },
    from(table: string) { return new Query(broker, table) as any; },
    channel(topic: string, opts?: any) {
      return new FakeChannel(topic, opts?.config?.presence?.key ?? 'anon', broker) as any;
    },
    removeChannel(c: FakeChannel) { broker.unregister(c); return Promise.resolve('ok'); },

    async rpc(name: string, args: any) {
      if (name === 'collab_join_document') {
        const existing = broker.rows('collab_permissions')
          .find((p) => p.document_id === args.doc && p.user_id === userId);
        if (existing) return { data: existing.role, error: null };
        broker.rows('collab_permissions').push({
          id: `perm-${Math.random()}`, document_id: args.doc, user_id: userId, role: 'editor',
        });
        return { data: 'editor', error: null };
      }

      if (name === 'collab_next_version') {
        const versions = broker.rows('collab_versions').filter((v) => v.document_id === args.doc);
        return { data: versions.length + 1, error: null };
      }

      if (name === 'collab_save_snapshot') {
        const doc = broker.rows('collab_documents').find((d) => d.id === args.doc);
        if (!doc) return { data: null, error: { code: 'P0002', message: 'not found' } };
        // The optimistic-concurrency guard, modelled faithfully so the retry
        // path in the hook actually runs.
        if (doc.snapshot_version !== args.expected_version) {
          return { data: null, error: { code: '40001', message: 'version_conflict' } };
        }
        doc.content = args.new_content;
        doc.crdt_state = args.new_state;
        doc.snapshot_seq = args.new_seq;
        doc.snapshot_version += 1;
        doc.last_saved_at = new Date().toISOString();
        broker.emitChange('collab_documents', 'UPDATE', doc);
        return { data: doc.snapshot_version, error: null };
      }

      return { data: null, error: null };
    },
  };
}

/** A document with an owner permission row, ready for a hook to open. */
export function seedDocument(broker: FakeBroker, docId = 'doc-1', ownerId = 'user-1') {
  broker.rows('collab_documents').push({
    id: docId, title: 'Test document', owner_id: ownerId, content: '',
    crdt_state: { nodes: [], marks: [], clock: 0 },
    snapshot_version: 0, snapshot_seq: 0,
    last_saved_at: new Date().toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  broker.rows('collab_permissions').push({
    id: 'perm-owner', document_id: docId, user_id: ownerId, role: 'owner',
  });
  broker.rows('collab_profiles').push({
    id: ownerId, display_name: 'Test User', color: '#8b7bf7',
  });
  return docId;
}
