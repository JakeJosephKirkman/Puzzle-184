'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Rga } from '@/lib/crdt/rga';
import { diffToOps } from '@/lib/crdt/diff';
import { UndoStack, forwardTransaction, invertTransaction } from '@/lib/crdt/undo';
import type { CharId, Mark, MarkType, Op } from '@/lib/crdt/types';
import { Outbox, type OutboxEntry } from '@/lib/realtime/outbox';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { canEdit } from '@/lib/identity';
import type { Identity } from './useIdentity';
import type {
  ActivityRow,
  CommentRow,
  ConnectionState,
  DocRole,
  DocumentRow,
  OperationRow,
  PresenceState,
  Profile,
  VersionRow,
} from '@/types/database';

const CURSOR_THROTTLE_MS = 60;
const TYPING_IDLE_MS = 2000;
const SAVE_DEBOUNCE_MS = 1500;
const SAVE_MAX_WAIT_MS = 10_000;
const AUTO_VERSION_EVERY_OPS = 50;
/** How close a remote edit must land to count as "the same section". */
const CONFLICT_PROXIMITY_CHARS = 60;
const CONFLICT_WINDOW_MS = 3000;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface ConflictNotice {
  id: number;
  name: string;
  color: string;
  at: number;
}

interface OpEnvelope {
  ops: Op[];
  marks?: Mark[];
  siteId: string;
  actorId: string;
  lamport: number;
}

export function useCollabDocument(documentId: string, identity: Identity | null) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);

  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [role, setRole] = useState<DocRole | null>(null);
  const [text, setText] = useState('');
  const [marks, setMarks] = useState<Mark[]>([]);
  const [peers, setPeers] = useState<PresenceState[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [conflicts, setConflicts] = useState<ConflictNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mutable collaboration state. These live in refs because the realtime
  // callbacks are long-lived and must never read a stale render's closure.
  const rgaRef = useRef<Rga | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const outboxRef = useRef<Outbox | null>(null);
  const lastSeqRef = useRef(0);
  const versionRef = useRef(0);
  const opsSinceVersionRef = useRef(0);
  const localCursorRef = useRef<number>(0);
  const lastLocalEditRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveDeadlineRef = useRef<number | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorSentAtRef = useRef(0);
  const presenceRef = useRef<PresenceState | null>(null);
  const conflictSeqRef = useRef(0);
  const subscribedRef = useRef(false);
  const undoRef = useRef<UndoStack | null>(null);
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false });

  const roleRef = useRef<DocRole | null>(null);
  roleRef.current = role;

  const syncText = useCallback(() => {
    const rga = rgaRef.current;
    if (!rga) return;
    setText(rga.text);
    setMarks(rga.activeMarks());
  }, []);

  // ---------------------------------------------------------------------------
  // Loading collaborators' profiles on demand
  // ---------------------------------------------------------------------------

  const ensureProfiles = useCallback(
    async (ids: (string | null)[]) => {
      const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
      if (wanted.length === 0) return;
      setProfiles((current) => {
        const missing = wanted.filter((id) => !current[id]);
        if (missing.length > 0) {
          void supabase
            .from('collab_profiles')
            .select('*')
            .in('id', missing)
            .then(({ data }) => {
              if (!data?.length) return;
              setProfiles((prev) => {
                const next = { ...prev };
                for (const p of data as Profile[]) next[p.id] = p;
                return next;
              });
            });
        }
        return current;
      });
    },
    [supabase],
  );

  // ---------------------------------------------------------------------------
  // Persisting operations
  //
  // Broadcast is fast but lossy; the database is the durable record. Every
  // operation goes to both, and the outbox holds anything the database has not
  // acknowledged yet.
  // ---------------------------------------------------------------------------

  const flushOutbox = useCallback(async () => {
    const outbox = outboxRef.current;
    if (!outbox || outbox.size === 0) return;

    const batch = outbox.all();
    const rows = batch.map((e) => ({
      document_id: e.documentId,
      actor_id: e.actorId,
      site_id: e.siteId,
      lamport: e.lamport,
      op_id: e.opId,
      op: e.op,
    }));

    // ignoreDuplicates makes a retried flush a no-op instead of an error: the
    // unique (document_id, op_id) index means replaying is always safe.
    const { error: insertError } = await supabase
      .from('collab_operations')
      .upsert(rows, { onConflict: 'document_id,op_id', ignoreDuplicates: true });

    if (insertError) {
      // Leave the entries queued; the next reconnect or edit retries them.
      setPendingCount(outbox.size);
      return;
    }

    outbox.ack(batch.map((e) => e.opId));
    setPendingCount(outbox.size);
  }, [supabase]);

  // ---------------------------------------------------------------------------
  // Autosave with optimistic concurrency
  // ---------------------------------------------------------------------------

  const saveSnapshot = useCallback(
    async (attempt = 0): Promise<void> => {
      const rga = rgaRef.current;
      if (!rga || !identity || !canEdit(roleRef.current)) return;

      setSaveState('saving');
      await flushOutbox();

      const { data, error: rpcError } = await supabase.rpc('collab_save_snapshot', {
        doc: documentId,
        expected_version: versionRef.current,
        new_content: rga.text,
        new_state: rga.snapshot(),
        new_seq: lastSeqRef.current,
      });

      if (rpcError) {
        // 40001 is our version_conflict: somebody else saved first. This is the
        // case the whole design exists for -- we do NOT overwrite them. We pull
        // what we missed, merge it through the CRDT (always safe, never lossy)
        // and try again against the new version.
        const isConflict =
          rpcError.code === '40001' || rpcError.message?.includes('version_conflict');

        if (isConflict && attempt < 4) {
          await catchUpRef.current?.();
          const { data: fresh } = await supabase
            .from('collab_documents')
            .select('snapshot_version')
            .eq('id', documentId)
            .single();
          if (fresh) versionRef.current = (fresh as { snapshot_version: number }).snapshot_version;
          return saveSnapshot(attempt + 1);
        }

        setSaveState('error');
        return;
      }

      versionRef.current = Number(data);
      setLastSavedAt(new Date().toISOString());
      setSaveState('saved');
    },
    [documentId, flushOutbox, identity, supabase],
  );

  const saveSnapshotRef = useRef(saveSnapshot);
  saveSnapshotRef.current = saveSnapshot;

  /** Debounced save with a hard ceiling, so a fast typist still gets saved. */
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const now = Date.now();
    if (saveDeadlineRef.current === null) saveDeadlineRef.current = now + SAVE_MAX_WAIT_MS;

    const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, saveDeadlineRef.current - now));
    saveTimerRef.current = setTimeout(() => {
      saveDeadlineRef.current = null;
      void saveSnapshotRef.current();
    }, delay);
  }, []);

  // ---------------------------------------------------------------------------
  // Catch-up: pull every operation we have not seen and merge it
  // ---------------------------------------------------------------------------

  const catchUp = useCallback(async () => {
    const rga = rgaRef.current;
    if (!rga) return;

    const { data, error: fetchError } = await supabase
      .from('collab_operations')
      .select('*')
      .eq('document_id', documentId)
      .gt('seq', lastSeqRef.current)
      .order('seq', { ascending: true });

    if (fetchError || !data) return;

    const rows = data as OperationRow[];
    const incoming: Op[] = [];
    for (const row of rows) {
      if (row.seq > lastSeqRef.current) lastSeqRef.current = row.seq;
      const payload = row.op as Op | { mark: Mark };
      if ('mark' in payload) rga.applyMark(payload.mark);
      else incoming.push(payload);
      rga.observeLamport(row.lamport);
    }

    if (incoming.length > 0) rga.applyRemote(incoming);
    syncText();
    await flushOutbox();
  }, [documentId, flushOutbox, supabase, syncText]);

  const catchUpRef = useRef<typeof catchUp | null>(null);
  catchUpRef.current = catchUp;

  // ---------------------------------------------------------------------------
  // Conflict awareness
  //
  // The CRDT has already merged the edit safely by the time we get here. This
  // only tells the humans it happened, so a sentence rearranging itself under
  // their cursor is explicable rather than alarming.
  // ---------------------------------------------------------------------------

  const noteConcurrentEdit = useCallback((ops: Op[], actorId: string) => {
    const rga = rgaRef.current;
    if (!rga) return;
    if (Date.now() - lastLocalEditRef.current > CONFLICT_WINDOW_MS) return;

    const caret = localCursorRef.current;
    const nearby = ops.some((op) => {
      const idx = rga.indexOfId(op.id);
      return idx >= 0 && Math.abs(idx - caret) <= CONFLICT_PROXIMITY_CHARS;
    });
    if (!nearby) return;

    const peer = presencePeersRef.current.find((p) => p.userId === actorId);
    const notice: ConflictNotice = {
      id: ++conflictSeqRef.current,
      name: peer?.name ?? 'Another collaborator',
      color: peer?.color ?? '#8b7bf7',
      at: Date.now(),
    };
    setConflicts((current) => [...current.slice(-2), notice]);
    setTimeout(() => {
      setConflicts((current) => current.filter((c) => c.id !== notice.id));
    }, 6000);
  }, []);

  const presencePeersRef = useRef<PresenceState[]>([]);
  presencePeersRef.current = peers;

  // ---------------------------------------------------------------------------
  // Load + subscribe
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!identity || !documentId) return;
    let cancelled = false;
    subscribedRef.current = false;

    const site = identity.sessionId;
    const outbox = new Outbox(documentId, identity.sessionId);
    outboxRef.current = outbox;
    undoRef.current = new UndoStack(identity.sessionId);
    setPendingCount(outbox.size);

    const load = async () => {
      setLoading(true);
      setError(null);

      // Joining is what creates the permission row for a visitor arriving via a
      // share link. Without it RLS correctly shows them nothing at all.
      const { data: joinedRole } = await supabase.rpc('collab_join_document', { doc: documentId });

      const { data: docRow, error: docError } = await supabase
        .from('collab_documents')
        .select('*')
        .eq('id', documentId)
        .maybeSingle();

      if (docError || !docRow) {
        if (!cancelled) {
          setError('This document does not exist, or you do not have access to it.');
          setLoading(false);
        }
        return;
      }

      const document = docRow as DocumentRow;
      const { data: perm } = await supabase
        .from('collab_permissions')
        .select('role')
        .eq('document_id', documentId)
        .eq('user_id', identity.user.id)
        .maybeSingle();

      const resolvedRole =
        ((perm as { role: DocRole } | null)?.role ??
          (joinedRole as DocRole | null) ??
          (document.owner_id === identity.user.id ? 'owner' : null)) ?? null;

      // Restore from the stored snapshot, then replay only what came after it.
      const snapshot = document.crdt_state;
      const rga =
        snapshot && Array.isArray(snapshot.nodes) && snapshot.nodes.length > 0
          ? Rga.fromSnapshot(site, snapshot)
          : new Rga(site);
      rga.setAuthor(identity.sessionId, identity.user.id);
      rgaRef.current = rga;
      lastSeqRef.current = document.snapshot_seq ?? 0;
      versionRef.current = document.snapshot_version;

      if (cancelled) return;
      setDoc(document);
      setRole(resolvedRole);
      setLastSavedAt(document.last_saved_at);

      await catchUpRef.current?.();

      // Anything the previous session queued while offline goes out now.
      await flushOutbox();

      const [{ data: versionRows }, { data: commentRows }, { data: activityRows }] =
        await Promise.all([
          supabase
            .from('collab_versions')
            .select('*')
            .eq('document_id', documentId)
            .order('version_number', { ascending: true }),
          supabase
            .from('collab_comments')
            .select('*')
            .eq('document_id', documentId)
            .order('created_at', { ascending: true }),
          supabase
            .from('collab_activity')
            .select('*')
            .eq('document_id', documentId)
            .order('created_at', { ascending: false })
            .limit(50),
        ]);

      if (cancelled) return;
      setVersions((versionRows ?? []) as VersionRow[]);
      setComments((commentRows ?? []) as CommentRow[]);
      setActivity((activityRows ?? []) as ActivityRow[]);
      void ensureProfiles([
        document.owner_id,
        ...((versionRows ?? []) as VersionRow[]).map((v) => v.created_by),
        ...((commentRows ?? []) as CommentRow[]).map((c) => c.author_id),
        ...((activityRows ?? []) as ActivityRow[]).map((a) => a.actor_id),
      ]);

      syncText();
      setLoading(false);
    };

    void load();

    // -------------------------------------------------------------------------
    // One channel, three transports.
    //
    //  - Presence     : ephemeral awareness, evicted automatically on disconnect
    //  - Broadcast    : low latency, lossy
    //  - Postgres     : durable, slower, and the reason a dropped packet is only
    //                   a latency problem rather than a lost edit
    // -------------------------------------------------------------------------

    const channel = supabase.channel(`doc:${documentId}`, {
      config: { presence: { key: identity.sessionId }, broadcast: { self: false } },
    });
    channelRef.current = channel;

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<PresenceState>();
        const flat = Object.values(state)
          .flat()
          .filter((p): p is PresenceState & { presence_ref: string } => Boolean(p?.sessionId));
        setPeers(flat.map((p) => ({ ...p })));
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        // A hard disconnect (closed lid, killed tab, dead network) lands here via
        // the heartbeat timeout, with no cooperation from the departing client.
        const left = leftPresences as unknown as PresenceState[];
        for (const p of left) {
          if (!p?.userId) continue;
          // Elect one recorder so N clients do not each log the same departure.
          const remaining = presencePeersRef.current
            .filter((x) => x.sessionId !== p.sessionId)
            .map((x) => x.sessionId)
            .sort();
          if (remaining[0] === identity.sessionId) {
            void supabase.from('collab_activity').insert({
              document_id: documentId,
              actor_id: p.userId,
              kind: 'leave',
              payload: { name: p.name, session_id: p.sessionId },
            });
          }
        }
      })
      .on('broadcast', { event: 'op' }, ({ payload }) => {
        const envelope = payload as OpEnvelope;
        const rga = rgaRef.current;
        if (!rga || envelope.siteId === site) return;

        rga.observeLamport(envelope.lamport);
        rga.setAuthor(envelope.siteId, envelope.actorId);
        const applied = rga.applyRemote(envelope.ops ?? []);
        for (const mark of envelope.marks ?? []) rga.applyMark(mark);
        if (applied.length > 0 || envelope.marks?.length) syncText();
        if (applied.length > 0) noteConcurrentEdit(applied, envelope.actorId);
      })
      .on('broadcast', { event: 'cursor' }, ({ payload }) => {
        const p = payload as PresenceState;
        if (p.sessionId === identity.sessionId) return;
        setPeers((current) =>
          current.map((peer) =>
            peer.sessionId === p.sessionId
              ? { ...peer, cursor: p.cursor, selection: p.selection }
              : peer,
          ),
        );
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        const p = payload as { sessionId: string; typing: boolean; nearLine: number | null };
        if (p.sessionId === identity.sessionId) return;
        setPeers((current) =>
          current.map((peer) =>
            peer.sessionId === p.sessionId
              ? { ...peer, typing: p.typing, typingNearLine: p.nearLine }
              : peer,
          ),
        );
      })
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'collab_operations', filter: `document_id=eq.${documentId}` },
        ({ new: row }) => {
          const op = row as OperationRow;
          const rga = rgaRef.current;
          if (!rga) return;
          if (op.seq > lastSeqRef.current) lastSeqRef.current = op.seq;
          if (op.site_id === site) return; // our own write coming back

          rga.observeLamport(op.lamport);
          rga.setAuthor(op.site_id, op.actor_id);
          const payload = op.op as Op | { mark: Mark };
          if ('mark' in payload) {
            if (rga.applyMark(payload.mark)) syncText();
            return;
          }
          // Idempotent: if broadcast already delivered this, applying is a no-op.
          const applied = rga.applyRemote([payload]);
          if (applied.length > 0) {
            syncText();
            noteConcurrentEdit(applied, op.actor_id);
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'collab_comments', filter: `document_id=eq.${documentId}` },
        ({ eventType, new: row, old: oldRow }) => {
          if (eventType === 'DELETE') {
            const removed = oldRow as { id: string };
            setComments((current) => current.filter((c) => c.id !== removed.id));
            return;
          }
          const comment = row as CommentRow;
          void ensureProfiles([comment.author_id, comment.resolved_by]);
          setComments((current) => {
            const without = current.filter((c) => c.id !== comment.id);
            return [...without, comment].sort((a, b) => a.created_at.localeCompare(b.created_at));
          });
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'collab_activity', filter: `document_id=eq.${documentId}` },
        ({ new: row }) => {
          const event = row as ActivityRow;
          if (!event?.id) return;
          void ensureProfiles([event.actor_id]);
          setActivity((current) => {
            const without = current.filter((a) => a.id !== event.id);
            return [event, ...without]
              .sort((a, b) => b.created_at.localeCompare(a.created_at))
              .slice(0, 50);
          });
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'collab_versions', filter: `document_id=eq.${documentId}` },
        ({ new: row }) => {
          const version = row as VersionRow;
          void ensureProfiles([version.created_by]);
          setVersions((current) =>
            [...current.filter((v) => v.id !== version.id), version].sort(
              (a, b) => a.version_number - b.version_number,
            ),
          );
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'collab_documents', filter: `id=eq.${documentId}` },
        ({ new: row }) => {
          const updated = row as DocumentRow;
          setDoc((current) => (current ? { ...current, ...updated } : updated));
          setLastSavedAt(updated.last_saved_at);
          if (updated.snapshot_version > versionRef.current) {
            versionRef.current = updated.snapshot_version;
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'collab_permissions', filter: `document_id=eq.${documentId}` },
        () => {
          // A role change must take effect immediately for the affected user --
          // demoting somebody to Viewer while they are typing has to bite now.
          void supabase
            .from('collab_permissions')
            .select('role')
            .eq('document_id', documentId)
            .eq('user_id', identity.user.id)
            .maybeSingle()
            .then(({ data }) => {
              const next = (data as { role: DocRole } | null)?.role ?? null;
              setRole(next);
            });
        },
      );

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        const wasDown = subscribedRef.current === false && connectionRef.current !== 'connecting';
        subscribedRef.current = true;
        setConnection('connected');

        const state: PresenceState = {
          userId: identity.user.id,
          sessionId: identity.sessionId,
          name: identity.profile.display_name,
          color: identity.profile.color,
          role: roleRef.current ?? 'viewer',
          cursor: null,
          selection: null,
          typing: false,
          typingNearLine: null,
          onlineAt: new Date().toISOString(),
        };
        presenceRef.current = state;
        await channel.track(state);

        // Reconnected: pull everything missed, then flush what we queued.
        if (wasDown) await catchUpRef.current?.();
        await flushOutbox();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        subscribedRef.current = false;
        setConnection('reconnecting');
      } else if (status === 'CLOSED') {
        subscribedRef.current = false;
        setConnection((c) => (c === 'offline' ? c : 'reconnecting'));
      }
    });

    // Log our arrival once the row exists.
    void supabase
      .from('collab_activity')
      .insert({
        document_id: documentId,
        actor_id: identity.user.id,
        kind: 'join',
        payload: { name: identity.profile.display_name, session_id: identity.sessionId },
      })
      .then(() => undefined);

    const handleOnline = () => {
      setConnection('reconnecting');
      void (async () => {
        await catchUpRef.current?.();
        await flushOutbox();
      })();
    };
    const handleOffline = () => setConnection('offline');
    const handleHide = () => {
      // Do not strand a pending save when the tab goes away.
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      void saveSnapshotRef.current();
      void channel.untrack();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('pagehide', handleHide);
    if (typeof navigator !== 'undefined' && !navigator.onLine) setConnection('offline');

    return () => {
      cancelled = true;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('pagehide', handleHide);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      void channel.untrack();
      void supabase.removeChannel(channel);
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, identity?.user.id, identity?.sessionId]);

  const connectionRef = useRef<ConnectionState>('connecting');
  connectionRef.current = connection;

  // ---------------------------------------------------------------------------
  // Local editing
  // ---------------------------------------------------------------------------

  const publish = useCallback(
    (ops: Op[], publishedMarks: Mark[] = []) => {
      const rga = rgaRef.current;
      if (!rga || !identity) return;

      if (ops.length > 0 || publishedMarks.length > 0) {
        void channelRef.current?.send({
          type: 'broadcast',
          event: 'op',
          payload: {
            ops,
            marks: publishedMarks,
            siteId: identity.sessionId,
            actorId: identity.user.id,
            lamport: rga.lamport,
          } satisfies OpEnvelope,
        });
      }

      const entries: OutboxEntry[] = [
        ...ops.map((op) => ({
          opId: op.t === 'ins' ? `i:${op.id}` : `d:${op.id}`,
          documentId,
          actorId: identity.user.id,
          siteId: identity.sessionId,
          lamport: rga.lamport,
          op,
        })),
        ...publishedMarks.map((mark) => ({
          opId: `m:${mark.id}:${mark.lamport}`,
          documentId,
          actorId: identity.user.id,
          siteId: identity.sessionId,
          lamport: mark.lamport,
          op: { mark } as unknown as Op,
        })),
      ];

      outboxRef.current?.add(entries);
      setPendingCount(outboxRef.current?.size ?? 0);
      opsSinceVersionRef.current += ops.length;

      void flushOutbox();
      scheduleSave();
    },
    [documentId, flushOutbox, identity, scheduleSave],
  );

  /** Apply the editor's new text as a minimal set of operations. */
  const applyText = useCallback(
    (next: string, caretIndex: number) => {
      const rga = rgaRef.current;
      if (!rga || !canEdit(roleRef.current)) return;

      const ops = diffToOps(rga, next);
      if (ops.length === 0) return;

      localCursorRef.current = caretIndex;
      lastLocalEditRef.current = Date.now();

      // Only our own operations are ever recorded, which is what makes undo
      // structurally incapable of reverting a collaborator's work.
      undoRef.current?.record(ops);
      setUndoState({
        canUndo: undoRef.current?.canUndo ?? false,
        canRedo: undoRef.current?.canRedo ?? false,
      });

      syncText();
      publish(ops);

      if (opsSinceVersionRef.current >= AUTO_VERSION_EVERY_OPS) {
        opsSinceVersionRef.current = 0;
        void createVersionRef.current?.(null);
      }
    },
    [publish, syncText],
  );

  /**
   * Undo this session's most recent transaction.
   *
   * Deleted characters are revived by id rather than retyped, so comments and
   * marks anchored to them reattach instead of staying orphaned.
   */
  const undo = useCallback(() => {
    const rga = rgaRef.current;
    const stack = undoRef.current;
    if (!rga || !stack || !canEdit(roleRef.current)) return;

    const tx = stack.popUndo();
    if (!tx) return;

    const { revive, remove } = invertTransaction(tx);
    const ops: Op[] = [...rga.localRevive(revive)];
    for (const id of remove) {
      const index = rga.indexOfId(id);
      if (index >= 0) ops.push(...rga.localDelete(index, 1));
    }

    setUndoState({ canUndo: stack.canUndo, canRedo: stack.canRedo });
    syncText();
    if (ops.length > 0) publish(ops);
  }, [publish, syncText]);

  const redo = useCallback(() => {
    const rga = rgaRef.current;
    const stack = undoRef.current;
    if (!rga || !stack || !canEdit(roleRef.current)) return;

    const tx = stack.popRedo();
    if (!tx) return;

    const { revive, remove } = forwardTransaction(tx);
    const ops: Op[] = [...rga.localRevive(revive)];
    for (const id of remove) {
      const index = rga.indexOfId(id);
      if (index >= 0) ops.push(...rga.localDelete(index, 1));
    }

    setUndoState({ canUndo: stack.canUndo, canRedo: stack.canRedo });
    syncText();
    if (ops.length > 0) publish(ops);
  }, [publish, syncText]);

  const applyMark = useCallback(
    (type: MarkType, startIndex: number, endIndex: number, value?: string) => {
      const rga = rgaRef.current;
      if (!rga || !canEdit(roleRef.current)) return;
      const startId = rga.idAtIndex(Math.min(startIndex, endIndex));
      const endId = rga.idAtIndex(Math.max(startIndex, endIndex) - 1);
      if (!startId || !endId) return;
      const mark = rga.addMark(type, startId, endId, value);
      syncText();
      publish([], [mark]);
    },
    [publish, syncText],
  );

  // ---------------------------------------------------------------------------
  // Awareness
  // ---------------------------------------------------------------------------

  const reportCursor = useCallback(
    (caretIndex: number, selection: { start: number; end: number } | null) => {
      const rga = rgaRef.current;
      if (!rga || !identity || !presenceRef.current) return;
      localCursorRef.current = caretIndex;

      const now = Date.now();
      if (now - cursorSentAtRef.current < CURSOR_THROTTLE_MS) return;
      cursorSentAtRef.current = now;

      // Positions travel as character ids, so they stay meaningful even after
      // the recipient's copy of the text has shifted underneath them.
      const cursor = { afterId: rga.leftIdForIndex(caretIndex) };
      const range =
        selection && selection.start !== selection.end
          ? {
              startAfterId: rga.leftIdForIndex(selection.start),
              endAfterId: rga.leftIdForIndex(selection.end),
            }
          : null;

      const next: PresenceState = { ...presenceRef.current, cursor, selection: range };
      presenceRef.current = next;

      void channelRef.current?.send({ type: 'broadcast', event: 'cursor', payload: next });
      void channelRef.current?.track(next);
    },
    [identity],
  );

  const reportTyping = useCallback(
    (caretIndex: number) => {
      const rga = rgaRef.current;
      if (!rga || !identity) return;
      const nearLine = rga.text.slice(0, caretIndex).split('\n').length;

      void channelRef.current?.send({
        type: 'broadcast',
        event: 'typing',
        payload: { sessionId: identity.sessionId, typing: true, nearLine },
      });

      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => {
        void channelRef.current?.send({
          type: 'broadcast',
          event: 'typing',
          payload: { sessionId: identity.sessionId, typing: false, nearLine: null },
        });
      }, TYPING_IDLE_MS);
    },
    [identity],
  );

  // ---------------------------------------------------------------------------
  // Versions
  // ---------------------------------------------------------------------------

  const createVersion = useCallback(
    async (label: string | null, restoredFrom: string | null = null) => {
      const rga = rgaRef.current;
      if (!rga || !identity || !canEdit(roleRef.current)) return;

      await flushOutbox();
      const { data: nextNumber } = await supabase.rpc('collab_next_version', { doc: documentId });

      const contributors = [
        ...new Set(presencePeersRef.current.map((p) => p.userId).concat(identity.user.id)),
      ];

      await supabase.from('collab_versions').insert({
        document_id: documentId,
        version_number: Number(nextNumber ?? 1),
        content: rga.text,
        crdt_snapshot: rga.snapshot(),
        created_by: identity.user.id,
        label,
        summary: {
          edits: opsSinceVersionRef.current,
          sections: rga.text.split('\n').filter((l) => l.trim().length > 0).length,
          contributors,
        },
        restored_from: restoredFrom,
      });
      opsSinceVersionRef.current = 0;
    },
    [documentId, flushOutbox, identity, supabase],
  );

  const createVersionRef = useRef(createVersion);
  createVersionRef.current = createVersion;

  /**
   * Restore an older version by editing forward into it.
   *
   * Emphatically not an overwrite: we diff the current text against the target
   * and apply the result as ordinary operations. Every connected client
   * converges on it live, the pre-restore state stays in history, and the
   * restore is itself undoable.
   */
  const restoreVersion = useCallback(
    async (version: VersionRow) => {
      const rga = rgaRef.current;
      if (!rga || !canEdit(roleRef.current)) return;

      // Snapshot where we were, so the restore can itself be rolled back.
      await createVersionRef.current?.('Before restore');

      const ops = diffToOps(rga, version.content);
      syncText();
      publish(ops);

      await createVersionRef.current?.(`Restored v${version.version_number}`, version.id);
      await saveSnapshotRef.current();
    },
    [publish, syncText],
  );

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  const addComment = useCallback(
    async (body: string, anchor: { start: number; end: number } | null, parentId?: string) => {
      const rga = rgaRef.current;
      if (!rga || !identity || !body.trim()) return;

      let anchorPayload = null;
      if (anchor && anchor.end > anchor.start) {
        const startId = rga.idAtIndex(anchor.start);
        const endId = rga.idAtIndex(anchor.end - 1);
        if (startId && endId) {
          anchorPayload = {
            startId,
            endId,
            quotedText: rga.text.slice(anchor.start, anchor.end),
          };
        }
      }

      await supabase.from('collab_comments').insert({
        document_id: documentId,
        parent_id: parentId ?? null,
        author_id: identity.user.id,
        body: body.trim(),
        anchor: anchorPayload,
      });
    },
    [documentId, identity, supabase],
  );

  const setCommentResolved = useCallback(
    async (commentId: string, resolved: boolean) => {
      if (!identity) return;
      await supabase
        .from('collab_comments')
        .update({
          resolved,
          resolved_by: resolved ? identity.user.id : null,
          resolved_at: resolved ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', commentId);
    },
    [identity, supabase],
  );

  // ---------------------------------------------------------------------------
  // Document metadata + sharing
  // ---------------------------------------------------------------------------

  const renameDocument = useCallback(
    async (title: string) => {
      if (!canEdit(roleRef.current)) return;
      await supabase.from('collab_documents').update({ title }).eq('id', documentId);
      setDoc((current) => (current ? { ...current, title } : current));
    },
    [documentId, supabase],
  );

  const changeRole = useCallback(
    async (userId: string, nextRole: DocRole) => {
      await supabase
        .from('collab_permissions')
        .update({ role: nextRole })
        .eq('document_id', documentId)
        .eq('user_id', userId);
      await supabase.from('collab_activity').insert({
        document_id: documentId,
        actor_id: identity?.user.id ?? null,
        kind: 'permission',
        payload: { target: userId, role: nextRole },
      });
    },
    [documentId, identity, supabase],
  );

  const rga = rgaRef.current;

  return {
    doc,
    role,
    text,
    marks,
    segments: rga ? rga.segments() : [],
    rga,
    peers: peers.filter((p) => p.sessionId !== identity?.sessionId),
    self: peers.find((p) => p.sessionId === identity?.sessionId) ?? null,
    allPeers: peers,
    connection,
    saveState,
    lastSavedAt,
    pendingCount,
    versions,
    comments,
    activity,
    profiles,
    conflicts,
    loading,
    error,
    canEdit: canEdit(role),
    canUndo: undoState.canUndo,
    canRedo: undoState.canRedo,
    actions: {
      applyText,
      applyMark,
      undo,
      redo,
      reportCursor,
      reportTyping,
      createVersion,
      restoreVersion,
      addComment,
      setCommentResolved,
      renameDocument,
      changeRole,
      saveNow: () => saveSnapshotRef.current(),
      indexOfCharId: (id: CharId) => rgaRef.current?.indexOfId(id) ?? -1,
    },
  };
}
