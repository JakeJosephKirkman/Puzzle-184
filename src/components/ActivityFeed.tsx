'use client';

import { relativeTime } from '@/lib/time';
import type { ActivityRow, Profile } from '@/types/database';

const ICONS: Record<string, string> = {
  edit: '✎',
  comment: '\u{1F4AC}',
  join: '→',
  leave: '←',
  restore: '↺',
  permission: '\u{1F511}',
};

function describe(event: ActivityRow): string {
  const payload = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case 'edit': {
      const ops = Number(payload.ops ?? 0);
      return ops > 1 ? `made ${ops} edits` : 'edited the document';
    }
    case 'comment':
      return payload.is_reply ? 'replied to a comment' : 'added a comment';
    case 'join':
      return 'joined the document';
    case 'leave':
      return 'left the document';
    case 'restore':
      return `restored version ${payload.restored_from_number ?? ''}`.trim();
    case 'permission':
      return `changed a collaborator to ${payload.role}`;
    default:
      return 'did something';
  }
}

export function ActivityFeed({
  activity,
  profiles,
  limit = 6,
}: {
  activity: ActivityRow[];
  profiles: Record<string, Profile>;
  limit?: number;
}) {
  return (
    <div className="panel" style={{ padding: 14 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Activity feed</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {activity.slice(0, limit).map((event) => {
          const profile = event.actor_id ? profiles[event.actor_id] : undefined;
          const name = profile?.display_name ?? 'Someone';
          return (
            <div key={event.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  background: 'var(--surface-3)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  flexShrink: 0,
                }}
              >
                {ICONS[event.kind] ?? '•'}
              </span>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.45 }}>
                <span style={{ fontWeight: 600 }}>{name}</span>{' '}
                <span style={{ color: 'var(--text-muted)' }}>{describe(event)}</span>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                {relativeTime(event.created_at)}
              </span>
            </div>
          );
        })}
        {activity.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>No activity yet.</div>
        )}
      </div>
    </div>
  );
}
