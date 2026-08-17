'use client';

import { useEffect } from 'react';
import type { PresenceState } from '@/types/database';

/**
 * Shown while following a collaborator's viewport.
 *
 * Following is a mode, and a mode you cannot see is a mode you get stuck in --
 * so it announces itself, names who you are following, and offers two obvious
 * ways out: Escape, or the button.
 */
export function FollowBanner({
  peer,
  onStop,
}: {
  peer: PresenceState | null;
  onStop: () => void;
}) {
  useEffect(() => {
    if (!peer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onStop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [peer, onStop]);

  if (!peer) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 10,
        background: 'var(--surface-2)',
        border: `1px solid ${peer.color}`,
        fontSize: 12.5,
      }}
    >
      <span
        style={{ width: 8, height: 8, borderRadius: '50%', background: peer.color }}
        aria-hidden="true"
      />
      <span style={{ flex: 1 }}>
        Following <strong style={{ color: peer.color }}>{peer.name}</strong> — the document
        scrolls with their cursor
      </span>
      <button className="btn" style={{ padding: '3px 9px', fontSize: 11 }} onClick={onStop}>
        Stop following (Esc)
      </button>
    </div>
  );
}
