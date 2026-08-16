'use client';

import { useState } from 'react';
import { Avatar } from './Avatar';
import { shortDateTime } from '@/lib/time';
import type { Profile, VersionRow } from '@/types/database';

/**
 * Version history timeline.
 *
 * Restoring never destroys anything: the current state is snapshotted first and
 * the restore is applied as a forward edit, so it propagates to everyone live
 * and is itself undoable from this same timeline.
 */
export function VersionHistory({
  versions,
  profiles,
  canEdit,
  currentContent,
  onRestore,
  onSaveVersion,
}: {
  versions: VersionRow[];
  profiles: Record<string, Profile>;
  canEdit: boolean;
  currentContent: string;
  onRestore: (version: VersionRow) => void;
  onSaveVersion: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const latest = versions[versions.length - 1] ?? null;
  const selected = versions.find((v) => v.id === selectedId) ?? latest;
  const isCurrent = selected?.id === latest?.id;
  const author = selected?.created_by ? profiles[selected.created_by] : undefined;

  return (
    <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
          padding: '10px 14px',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>Version history</span>
        <button className="btn" style={{ padding: '4px 9px', fontSize: 11 }} disabled={!canEdit} onClick={onSaveVersion}>
          Save version
        </button>
      </div>

      {versions.length === 0 ? (
        <div style={{ padding: 20, fontSize: 12, color: 'var(--text-faint)' }}>
          No versions saved yet. One is captured automatically as you edit.
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto', padding: '22px 14px 14px' }}>
            <div style={{ position: 'relative', display: 'flex', gap: 34, minWidth: 'min-content' }}>
              <div
                style={{
                  position: 'absolute',
                  top: 6,
                  left: 8,
                  right: 8,
                  height: 2,
                  background: 'var(--border-strong)',
                }}
              />
              {versions.map((version) => {
                const active = version.id === selected?.id;
                return (
                  <button
                    key={version.id}
                    onClick={() => setSelectedId(version.id)}
                    style={{
                      position: 'relative',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 8,
                      minWidth: 62,
                    }}
                  >
                    <span
                      style={{
                        width: active ? 26 : 12,
                        height: active ? 20 : 12,
                        borderRadius: active ? 6 : '50%',
                        background: active ? 'var(--accent)' : 'var(--blue)',
                        color: '#fff',
                        fontSize: 10,
                        fontWeight: 700,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginTop: active ? -3 : 0,
                        border: '2px solid var(--surface)',
                      }}
                    >
                      {active ? `v${version.version_number}` : ''}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>
                      v{version.version_number}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        color: 'var(--text-faint)',
                        whiteSpace: 'pre-line',
                        textAlign: 'center',
                        lineHeight: 1.35,
                      }}
                    >
                      {shortDateTime(version.created_at)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {selected && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.1fr 1fr 1.4fr auto',
                gap: 18,
                borderTop: '1px solid var(--border)',
                padding: 14,
                alignItems: 'start',
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                  Version {selected.version_number}
                  {isCurrent ? ' (Current)' : ''}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10 }}>
                  {new Date(selected.created_at).toLocaleString()}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Avatar
                    name={author?.display_name ?? '?'}
                    color={author?.color ?? '#6b7488'}
                    size={22}
                  />
                  <span style={{ fontSize: 12 }}>{author?.display_name ?? 'Unknown'}</span>
                </div>
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                  Changes in this version
                </div>
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 16,
                    fontSize: 11.5,
                    color: 'var(--text-muted)',
                    lineHeight: 1.8,
                  }}
                >
                  <li>{selected.summary?.edits ?? 0} edits</li>
                  <li>{selected.summary?.sections ?? 0} sections</li>
                  <li>{selected.content.length} characters</li>
                  {selected.restored_from && <li>Restored from an earlier version</li>}
                </ul>
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Preview</div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--text-muted)',
                    maxHeight: 76,
                    overflow: 'hidden',
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {selected.content.slice(0, 220) || '(empty document)'}
                </div>
              </div>

              <button
                className="btn btn-primary"
                disabled={!canEdit || selected.content === currentContent}
                title={
                  selected.content === currentContent
                    ? 'This version matches the current document'
                    : 'Restore this version for everyone'
                }
                onClick={() => onRestore(selected)}
              >
                ↺ Restore
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
