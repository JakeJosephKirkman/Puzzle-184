'use client';

import { Avatar } from './Avatar';
import { roleLabel } from '@/lib/identity';
import type { PresenceState } from '@/types/database';

/**
 * Who is in the document right now.
 *
 * Presence is ephemeral and heartbeat-backed, so a browser that dies without
 * saying goodbye still disappears from this list on its own.
 */
export function PresencePanel({
  peers,
  selfSessionId,
  followingSessionId,
  onFollow,
}: {
  peers: PresenceState[];
  selfSessionId: string | null;
  followingSessionId?: string | null;
  onFollow?: (sessionId: string | null) => void;
}) {
  const ordered = [...peers].sort((a, b) => {
    if (a.sessionId === selfSessionId) return -1;
    if (b.sessionId === selfSessionId) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="panel" style={{ padding: 14 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          Currently online ({ordered.length})
        </h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ordered.map((peer) => {
          const isSelf = peer.sessionId === selfSessionId;
          const editing = peer.role !== 'viewer';
          const following = followingSessionId === peer.sessionId;
          const canFollow = Boolean(onFollow) && !isSelf;

          return (
            <div
              key={peer.sessionId}
              role={canFollow ? 'button' : undefined}
              tabIndex={canFollow ? 0 : undefined}
              aria-pressed={canFollow ? following : undefined}
              aria-label={canFollow ? `Follow ${peer.name}` : undefined}
              onClick={canFollow ? () => onFollow?.(following ? null : peer.sessionId) : undefined}
              onKeyDown={
                canFollow
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onFollow?.(following ? null : peer.sessionId);
                      }
                    }
                  : undefined
              }
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: canFollow ? 'pointer' : undefined,
                background: following ? 'var(--accent-soft)' : undefined,
                borderRadius: 8,
                padding: following ? '4px 6px' : undefined,
                margin: following ? '-4px -6px' : undefined,
              }}
            >
              <Avatar name={peer.name} color={peer.color} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {isSelf ? 'You' : peer.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                  {roleLabel(peer.role)}
                </div>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {following ? 'Following' : editing ? 'Editing' : 'Viewing'}
              </span>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: peer.typing ? 'var(--green)' : peer.color,
                }}
              />
            </div>
          );
        })}
        {ordered.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Nobody else is here yet.</div>
        )}
      </div>
    </div>
  );
}

export function TypingIndicator({ peers }: { peers: PresenceState[] }) {
  const typing = peers.filter((p) => p.typing);
  if (typing.length === 0) return null;

  return (
    <div
      className="panel"
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        padding: 12,
        width: 240,
        zIndex: 20,
        background: 'var(--surface-2)',
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
        People are typing…
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {typing.map((peer) => (
          <div key={peer.sessionId} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Avatar name={peer.name} color={peer.color} size={26} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{peer.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                {peer.typingNearLine ? `Editing near line ${peer.typingNearLine}` : 'Editing'}
              </div>
            </div>
            <span
              className="pulse"
              style={{ width: 7, height: 7, borderRadius: '50%', background: peer.color }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
