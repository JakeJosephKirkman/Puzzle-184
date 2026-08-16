'use client';

import { useState } from 'react';
import { Avatar } from './Avatar';
import { relativeTime } from '@/lib/time';
import type { CommentRow, Profile } from '@/types/database';

interface Props {
  comments: CommentRow[];
  profiles: Record<string, Profile>;
  selection: { start: number; end: number } | null;
  selectedText: string;
  activeCommentId: string | null;
  /** True when every character the comment was anchored to has been deleted. */
  isOrphaned: (comment: CommentRow) => boolean;
  onAdd: (body: string, anchor: { start: number; end: number } | null, parentId?: string) => void;
  onResolve: (commentId: string, resolved: boolean) => void;
  onFocusComment: (commentId: string) => void;
}

export function CommentsPanel({
  comments,
  profiles,
  selection,
  selectedText,
  activeCommentId,
  isOrphaned,
  onAdd,
  onResolve,
  onFocusComment,
}: Props) {
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  const threads = comments.filter((c) => !c.parent_id);
  const visible = showResolved ? threads : threads.filter((t) => !t.resolved);
  const repliesOf = (id: string) => comments.filter((c) => c.parent_id === id);

  return (
    <div className="panel" style={{ padding: 14, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Comments ({visible.length})</h3>
        <button
          className="btn"
          style={{ padding: '3px 8px', fontSize: 11 }}
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? 'Hide resolved' : 'Show resolved'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 360, overflowY: 'auto' }}>
        {visible.map((thread) => {
          const author = profiles[thread.author_id];
          const orphaned = isOrphaned(thread);
          return (
            <div
              key={thread.id}
              onClick={() => onFocusComment(thread.id)}
              style={{
                background: activeCommentId === thread.id ? 'var(--accent-soft)' : 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: 11,
                cursor: 'pointer',
                opacity: thread.resolved ? 0.6 : 1,
              }}
            >
              {thread.anchor && (
                <div
                  style={{
                    fontSize: 11,
                    color: orphaned ? 'var(--text-faint)' : 'var(--text-muted)',
                    borderLeft: `2px solid ${orphaned ? 'var(--text-faint)' : 'var(--accent)'}`,
                    paddingLeft: 7,
                    marginBottom: 8,
                    fontStyle: orphaned ? 'italic' : 'normal',
                  }}
                >
                  {orphaned ? 'On deleted text: ' : ''}
                  &ldquo;{thread.anchor.quotedText.slice(0, 80)}&rdquo;
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <Avatar
                  name={author?.display_name ?? '?'}
                  color={author?.color ?? '#6b7488'}
                  size={24}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {author?.display_name ?? 'Someone'}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                      {relativeTime(thread.created_at)}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>
                    {thread.body}
                  </div>
                </div>
              </div>

              {repliesOf(thread.id).map((reply) => {
                const replyAuthor = profiles[reply.author_id];
                return (
                  <div
                    key={reply.id}
                    style={{ display: 'flex', gap: 8, marginTop: 10, marginLeft: 16 }}
                  >
                    <Avatar
                      name={replyAuthor?.display_name ?? '?'}
                      color={replyAuthor?.color ?? '#6b7488'}
                      size={22}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>
                          {replyAuthor?.display_name ?? 'Someone'}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                          {relativeTime(reply.created_at)}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                        {reply.body}
                      </div>
                    </div>
                  </div>
                );
              })}

              <div style={{ display: 'flex', gap: 10, marginTop: 9 }}>
                <button
                  className="btn"
                  style={{ padding: '3px 8px', fontSize: 11 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setReplyTo(replyTo === thread.id ? null : thread.id);
                  }}
                >
                  Reply
                </button>
                <button
                  className="btn"
                  style={{ padding: '3px 8px', fontSize: 11 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onResolve(thread.id, !thread.resolved);
                  }}
                >
                  {thread.resolved ? 'Reopen' : 'Resolve'}
                </button>
              </div>

              {replyTo === thread.id && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                  <input
                    className="input"
                    autoFocus
                    value={replyDraft}
                    placeholder="Write a reply…"
                    onChange={(e) => setReplyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && replyDraft.trim()) {
                        onAdd(replyDraft, null, thread.id);
                        setReplyDraft('');
                        setReplyTo(null);
                      }
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
        {visible.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            No comments yet. Select text in the document to start a thread.
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        {selection && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              marginBottom: 6,
              borderLeft: '2px solid var(--accent)',
              paddingLeft: 7,
            }}
          >
            Commenting on &ldquo;{selectedText.slice(0, 60)}&rdquo;
          </div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="input"
            value={draft}
            placeholder={selection ? 'Add a comment…' : 'Select text to comment'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                onAdd(draft, selection);
                setDraft('');
              }
            }}
          />
          <button
            className="btn btn-primary"
            disabled={!draft.trim()}
            onClick={() => {
              if (!draft.trim()) return;
              onAdd(draft, selection);
              setDraft('');
            }}
          >
            Post
          </button>
        </div>
      </div>
    </div>
  );
}
