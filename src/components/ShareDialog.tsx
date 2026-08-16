'use client';

import { useEffect, useState } from 'react';
import { Avatar } from './Avatar';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import type { DocRole, PermissionRow, Profile } from '@/types/database';

/**
 * Collaborator management.
 *
 * Only owners see the role controls, and the database enforces that
 * independently -- these selects are a convenience, not the security boundary.
 */
export function ShareDialog({
  documentId,
  isOwner,
  selfId,
  profiles,
  onClose,
  onChangeRole,
}: {
  documentId: string;
  isOwner: boolean;
  selfId: string;
  profiles: Record<string, Profile>;
  onClose: () => void;
  onChangeRole: (userId: string, role: DocRole) => Promise<void>;
}) {
  const [rows, setRows] = useState<PermissionRow[]>([]);
  const [copied, setCopied] = useState(false);
  const [names, setNames] = useState<Record<string, Profile>>(profiles);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    void (async () => {
      const { data } = await supabase
        .from('document_permissions')
        .select('*')
        .eq('document_id', documentId);
      const permissions = (data ?? []) as PermissionRow[];
      setRows(permissions);

      const missing = permissions.map((p) => p.user_id).filter((id) => !names[id]);
      if (missing.length > 0) {
        const { data: fetched } = await supabase.from('profiles').select('*').in('id', missing);
        if (fetched) {
          setNames((current) => {
            const next = { ...current };
            for (const p of fetched as Profile[]) next[p.id] = p;
            return next;
          });
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        className="panel"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460, padding: 20, background: 'var(--surface-2)' }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Share this document</h3>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--text-muted)' }}>
          Anyone with the link can open it and will join as an Editor. You can change anyone&rsquo;s
          role below.
        </p>

        <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
          <input className="input" readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
          <button
            className="btn btn-primary"
            onClick={() => {
              void navigator.clipboard?.writeText(shareUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 260, overflowY: 'auto' }}>
          {rows.map((row) => {
            const profile = names[row.user_id];
            return (
              <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar
                  name={profile?.display_name ?? '?'}
                  color={profile?.color ?? '#6b7488'}
                  size={26}
                />
                <span style={{ flex: 1, fontSize: 13 }}>
                  {profile?.display_name ?? 'Collaborator'}
                  {row.user_id === selfId ? ' (you)' : ''}
                </span>
                {isOwner && row.role !== 'owner' ? (
                  <select
                    className="input"
                    style={{ width: 110, padding: '5px 8px' }}
                    value={row.role}
                    onChange={async (e) => {
                      const next = e.target.value as DocRole;
                      setRows((current) =>
                        current.map((r) => (r.id === row.id ? { ...r, role: next } : r)),
                      );
                      await onChangeRole(row.user_id, next);
                    }}
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                    {row.role}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
