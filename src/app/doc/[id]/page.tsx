'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Editor } from '@/components/Editor';
import { Toolbar } from '@/components/Toolbar';
import { PresencePanel, TypingIndicator } from '@/components/PresencePanel';
import { ActivityFeed } from '@/components/ActivityFeed';
import { CommentsPanel } from '@/components/CommentsPanel';
import { VersionHistory } from '@/components/VersionHistory';
import { ShareDialog } from '@/components/ShareDialog';
import { AvatarStack } from '@/components/Avatar';
import { useIdentity } from '@/lib/collab/useIdentity';
import { useCollabDocument } from '@/lib/collab/useCollabDocument';
import { clockTime } from '@/lib/time';
import { roleLabel } from '@/lib/identity';
import type { MarkType } from '@/lib/crdt/types';
import type { CommentRow } from '@/types/database';

export default function DocumentPage() {
  const params = useParams<{ id: string }>();
  const documentId = params.id;

  const { identity, loading: authLoading, error: authError, rename } = useIdentity();
  const collab = useCollabDocument(documentId, identity);

  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [showAuthors, setShowAuthors] = useState(false);

  const selectedText = selection ? collab.text.slice(selection.start, selection.end) : '';

  /**
   * A comment is orphaned when every character it was anchored to has been
   * deleted. We still show the thread, with the text it was written about, so
   * the discussion is never silently lost.
   */
  const isOrphaned = useMemo(
    () => (comment: CommentRow) => {
      if (!comment.anchor || !collab.rga) return false;
      return (
        collab.rga.indexOfId(comment.anchor.startId) < 0 &&
        collab.rga.indexOfId(comment.anchor.endId) < 0
      );
    },
    [collab.rga],
  );

  // Heatmap palette: a person's tint matches their cursor and avatar, so the
  // colour means the same thing everywhere in the interface.
  const authorColors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, profile] of Object.entries(collab.profiles)) out[id] = profile.color;
    for (const peer of collab.allPeers) out[peer.userId] ??= peer.color;
    return out;
  }, [collab.profiles, collab.allPeers]);

  const authorNames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, profile] of Object.entries(collab.profiles)) out[id] = profile.display_name;
    for (const peer of collab.allPeers) out[peer.userId] ??= peer.name;
    return out;
  }, [collab.profiles, collab.allPeers]);

  // Collapsed to a single sentence so assistive tech is informed, not flooded.
  const liveAnnouncement = useMemo(() => {
    const others = collab.peers.length;
    const typing = collab.peers.filter((p) => p.typing).map((p) => p.name);
    const parts: string[] = [];
    if (others > 0) parts.push(`${others} other ${others === 1 ? 'person' : 'people'} editing`);
    if (typing.length > 0) parts.push(`${typing.join(' and ')} typing`);
    if (collab.connection !== 'connected') parts.push(`Connection ${collab.connection}`);
    return parts.join('. ');
  }, [collab.peers, collab.connection]);

  const focusComment = (commentId: string) => {
    setActiveCommentId(commentId);
    setTimeout(() => setActiveCommentId((c) => (c === commentId ? null : c)), 1600);
  };

  if (authLoading) {
    return <Centered>Signing you in…</Centered>;
  }
  if (authError) {
    return <Centered tone="error">{authError}</Centered>;
  }
  if (collab.error) {
    return <Centered tone="error">{collab.error}</Centered>;
  }

  const saveLabel =
    collab.saveState === 'saving'
      ? 'Saving…'
      : collab.saveState === 'error'
        ? 'Save failed — retrying'
        : `Last saved ${clockTime(collab.lastSavedAt)}`;

  return (
    <div className="app-shell">
      <Sidebar
        identity={identity}
        connection={collab.connection}
        pending={collab.pendingCount}
        onRename={rename}
      />

      {/*
        Collaboration is conveyed almost entirely by colour and motion -- remote
        carets, presence dots, typing pulses. None of that reaches a screen
        reader, so the same signal is announced politely here.
      */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      <main className="doc-main">
        <section
          className="doc-section"
          style={{ flex: 1, minWidth: 0, padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          {/* Header */}
          <header className="doc-header" style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                value={titleDraft ?? collab.doc?.title ?? ''}
                disabled={!collab.canEdit}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  if (titleDraft !== null && titleDraft !== collab.doc?.title) {
                    void collab.actions.renameDocument(titleDraft);
                  }
                  setTitleDraft(null);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--text)',
                  fontSize: 20,
                  fontWeight: 700,
                  padding: 0,
                  width: '100%',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  marginTop: 5,
                  fontSize: 11.5,
                  color: 'var(--text-muted)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                    }}
                  />
                  Saved automatically
                </span>
                <span>✓ {saveLabel}</span>
              </div>
            </div>

            <AvatarStack
              people={collab.allPeers.map((p) => ({ name: p.name, color: p.color }))}
            />

            <button className="btn btn-primary" onClick={() => setShareOpen(true)}>
              Share
            </button>

            <span
              className="btn"
              style={{ cursor: 'default', background: 'var(--surface-3)' }}
              title="Your permission on this document"
            >
              {collab.canEdit ? '🔓' : '🔒'} {roleLabel(collab.role)}
            </span>
          </header>

          {/* Conflict notices: the merge already happened safely, this explains it. */}
          {collab.conflicts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {collab.conflicts.map((conflict) => (
                <div
                  key={conflict.id}
                  className="panel"
                  style={{
                    padding: '8px 12px',
                    fontSize: 12.5,
                    borderColor: conflict.color,
                    background: 'var(--surface-2)',
                  }}
                >
                  <strong style={{ color: conflict.color }}>{conflict.name}</strong> is editing this
                  section too — both sets of changes were merged automatically.
                </div>
              ))}
            </div>
          )}

          {/* Editor */}
          <div className="panel" style={{ position: 'relative', overflow: 'visible' }}>
            <Toolbar
              disabled={!collab.canEdit}
              hasSelection={Boolean(selection)}
              canUndo={collab.canUndo}
              canRedo={collab.canRedo}
              showAuthors={showAuthors}
              onUndo={collab.actions.undo}
              onRedo={collab.actions.redo}
              onToggleAuthors={() => setShowAuthors((v) => !v)}
              onMark={(type: MarkType) => {
                if (selection) collab.actions.applyMark(type, selection.start, selection.end);
              }}
              onComment={() => {
                const el = document.querySelector<HTMLInputElement>('[data-comment-input]');
                el?.focus();
              }}
            />

            <div style={{ padding: '20px 24px 28px', position: 'relative' }}>
              <TypingIndicator peers={collab.peers} />
              {collab.loading ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading document…</div>
              ) : (
                <Editor
                  rga={collab.rga}
                  text={collab.text}
                  marks={collab.marks}
                  comments={collab.comments}
                  peers={collab.peers}
                  readOnly={!collab.canEdit}
                  activeCommentId={activeCommentId}
                  showAuthors={showAuthors}
                  authorColors={authorColors}
                  authorNames={authorNames}
                  onUndo={collab.actions.undo}
                  onRedo={collab.actions.redo}
                  onChange={collab.actions.applyText}
                  onCaret={collab.actions.reportCursor}
                  onTyping={collab.actions.reportTyping}
                  onSelectionChange={setSelection}
                  onCommentClick={focusComment}
                />
              )}
            </div>
          </div>

          <VersionHistory
            versions={collab.versions}
            profiles={collab.profiles}
            canEdit={collab.canEdit}
            currentContent={collab.text}
            onRestore={(version) => void collab.actions.restoreVersion(version)}
            onSaveVersion={() => void collab.actions.createVersion('Manual save')}
          />
        </section>

        {/* Right rail */}
        <aside
          className="doc-rail"
          aria-label="Collaboration panels"
          style={{
            width: 320,
            flexShrink: 0,
            borderLeft: '1px solid var(--border)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            height: '100vh',
            overflowY: 'auto',
            position: 'sticky',
            top: 0,
          }}
        >
          <PresencePanel peers={collab.allPeers} selfSessionId={identity?.sessionId ?? null} />
          <ActivityFeed activity={collab.activity} profiles={collab.profiles} />
          <div data-comment-input>
            <CommentsPanel
              comments={collab.comments}
              profiles={collab.profiles}
              selection={selection}
              selectedText={selectedText}
              activeCommentId={activeCommentId}
              isOrphaned={isOrphaned}
              onAdd={(body, anchor, parentId) =>
                void collab.actions.addComment(body, anchor, parentId)
              }
              onResolve={(id, resolved) => void collab.actions.setCommentResolved(id, resolved)}
              onFocusComment={focusComment}
            />
          </div>
        </aside>
      </main>

      {shareOpen && identity && (
        <ShareDialog
          documentId={documentId}
          isOwner={collab.role === 'owner'}
          selfId={identity.user.id}
          profiles={collab.profiles}
          onClose={() => setShareOpen(false)}
          onChangeRole={collab.actions.changeRole}
        />
      )}
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
      }}
    >
      <div
        className="panel"
        style={{
          padding: 24,
          maxWidth: 460,
          fontSize: 13,
          lineHeight: 1.6,
          color: tone === 'error' ? 'var(--text)' : 'var(--text-muted)',
          borderColor: tone === 'error' ? 'var(--red)' : 'var(--border)',
        }}
      >
        {children}
      </div>
    </div>
  );
}
