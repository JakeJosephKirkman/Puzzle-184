'use client';

import type { ConnectionState } from '@/types/database';

const LABELS: Record<ConnectionState, { title: string; detail: string; color: string }> = {
  connected: { title: 'Synced & online', detail: 'All changes are up to date', color: 'var(--green)' },
  connecting: { title: 'Connecting…', detail: 'Joining the document', color: 'var(--amber)' },
  reconnecting: {
    title: 'Reconnecting…',
    detail: 'Your edits are queued and will sync',
    color: 'var(--amber)',
  },
  offline: {
    title: 'Offline',
    detail: 'Editing locally — changes sync on reconnect',
    color: 'var(--red)',
  },
};

/**
 * The honest state of the connection.
 *
 * "Offline" deliberately does not read as an error: edits keep working and are
 * queued in the outbox, so the message says what will happen rather than
 * implying the user should stop typing.
 */
export function SyncStatus({
  connection,
  pending,
}: {
  connection: ConnectionState;
  pending: number;
}) {
  const state = LABELS[connection];
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          className={connection === 'connected' ? undefined : 'pulse'}
          style={{ width: 8, height: 8, borderRadius: '50%', background: state.color }}
        />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{state.title}</span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4, marginLeft: 16 }}>
        {pending > 0 ? `${pending} edit${pending === 1 ? '' : 's'} queued for sync` : state.detail}
      </div>
    </div>
  );
}
