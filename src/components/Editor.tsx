'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Mark } from '@/lib/crdt/types';
import type { Rga } from '@/lib/crdt/rga';
import type { CommentRow, PresenceState } from '@/types/database';
import {
  boxForOffset,
  boxesForRange,
  getCaretOffset,
  getSelectionRange,
  setCaretOffset,
} from '@/lib/dom';

interface Run {
  text: string;
  marks: Mark[];
  commentIds: string[];
  resolved: boolean;
  from: number;
  author: string | null;
}

interface EditorProps {
  rga: Rga | null;
  text: string;
  marks: Mark[];
  comments: CommentRow[];
  peers: PresenceState[];
  readOnly: boolean;
  activeCommentId: string | null;
  showAuthors: boolean;
  authorColors: Record<string, string>;
  authorNames: Record<string, string>;
  onUndo: () => void;
  onRedo: () => void;
  onChange: (next: string, caret: number) => void;
  onCaret: (caret: number, selection: { start: number; end: number } | null) => void;
  onTyping: (caret: number) => void;
  onSelectionChange: (selection: { start: number; end: number } | null) => void;
  onCommentClick: (commentId: string) => void;
}

const MARK_CLASS: Record<string, string> = {
  bold: 'mk-bold',
  italic: 'mk-italic',
  underline: 'mk-underline',
  code: 'mk-code',
  highlight: 'mk-highlight',
  heading1: 'mk-heading1',
  heading2: 'mk-heading2',
  heading3: 'mk-heading3',
};

export function Editor({
  rga,
  text,
  marks,
  comments,
  peers,
  readOnly,
  activeCommentId,
  showAuthors,
  authorColors,
  authorNames,
  onUndo,
  onRedo,
  onChange,
  onCaret,
  onTyping,
  onSelectionChange,
  onCommentClick,
}: EditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  // The caret is remembered as a character id, not an offset, so a remote edit
  // landing above it does not drag it out of position.
  const caretRef = useRef<{ afterId: string | null }>({ afterId: null });
  const [overlayTick, setOverlayTick] = useState(0);

  /**
   * Split the document into runs that share formatting and comment coverage.
   * Ranges resolve through character ids, so a comment stays welded to its
   * sentence however much text is inserted or deleted around it.
   */
  const runs = useMemo<Run[]>(() => {
    if (!rga || text.length === 0) return [];

    const markRanges = marks
      .map((m) => ({ m, from: rga.indexOfId(m.startId), to: rga.indexOfId(m.endId) }))
      .filter((r) => r.from >= 0 && r.to >= 0);

    const commentRanges = comments
      .filter((c) => c.anchor && !c.parent_id)
      .map((c) => ({
        c,
        from: rga.indexOfId(c.anchor!.startId),
        to: rga.indexOfId(c.anchor!.endId),
      }))
      .filter((r) => r.from >= 0 && r.to >= 0);

    const out: Run[] = [];
    let current: Run | null = null;
    let signature = '';

    for (let i = 0; i < text.length; i++) {
      const activeMarks = markRanges
        .filter((r) => i >= Math.min(r.from, r.to) && i <= Math.max(r.from, r.to))
        .map((r) => r.m);
      const activeComments = commentRanges.filter(
        (r) => i >= Math.min(r.from, r.to) && i <= Math.max(r.from, r.to),
      );

      // Authorship is part of the run signature only while the heatmap is on,
      // so normal rendering does not fragment into a span per author.
      const author = showAuthors ? rga.authorOf(rga.idAtIndex(i) ?? '') : null;

      const sig = [
        ...activeMarks.map((m) => `${m.type}:${m.value ?? ''}`).sort(),
        ...activeComments.map((r) => `c:${r.c.id}:${r.c.resolved}`).sort(),
        showAuthors ? `a:${author ?? 'unknown'}` : '',
      ].join('|');

      if (current && sig === signature) {
        current.text += text[i];
      } else {
        if (current) out.push(current);
        current = {
          text: text[i],
          marks: activeMarks,
          commentIds: activeComments.map((r) => r.c.id),
          resolved: activeComments.length > 0 && activeComments.every((r) => r.c.resolved),
          from: i,
          author,
        };
        signature = sig;
      }
    }
    if (current) out.push(current);
    return out;
  }, [rga, text, marks, comments, showAuthors]);

  /**
   * Reconcile the DOM with the CRDT after a remote change.
   *
   * React has already rewritten the contents by this point, which would
   * normally throw the caret to the start of the document. We put it back where
   * the user actually is by re-resolving the remembered character id.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !rga) return;
    if (document.activeElement !== el) return;

    const desired = rga.indexFromCursor(caretRef.current);
    const actual = getCaretOffset(el);
    if (actual !== desired) setCaretOffset(el, desired);
  }, [runs, rga]);

  // Remote carets are measured from the live DOM, so they need recomputing
  // whenever the text reflows or the window resizes.
  useEffect(() => {
    const bump = () => setOverlayTick((t) => t + 1);
    window.addEventListener('resize', bump);
    return () => window.removeEventListener('resize', bump);
  }, []);

  useEffect(() => {
    setOverlayTick((t) => t + 1);
  }, [text, peers]);

  const rememberCaret = useCallback(
    (offset: number) => {
      if (!rga) return;
      caretRef.current = rga.cursorFromIndex(offset);
    },
    [rga],
  );

  const handleInput = useCallback(() => {
    const el = ref.current;
    if (!el || readOnly) return;
    const next = el.textContent ?? '';
    const caret = getCaretOffset(el) ?? next.length;

    onChange(next, caret);
    rememberCaret(caret);
    onTyping(caret);
    onCaret(caret, null);
  }, [onCaret, onChange, onTyping, readOnly, rememberCaret]);

  /** Insert plain text ourselves so the browser cannot invent its own markup. */
  const insertAtCaret = useCallback(
    (value: string) => {
      const el = ref.current;
      if (!el || readOnly) return;
      const selection = getSelectionRange(el) ?? { start: text.length, end: text.length };
      const next = text.slice(0, selection.start) + value + text.slice(selection.end);
      const caret = selection.start + value.length;

      onChange(next, caret);
      rememberCaret(caret);
      onTyping(caret);
      onCaret(caret, null);
    },
    [onCaret, onChange, onTyping, readOnly, rememberCaret, text],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (readOnly) {
        // Let navigation and copying through; block anything that would mutate.
        const allowed =
          event.metaKey ||
          event.ctrlKey ||
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab'].includes(
            event.key,
          );
        if (!allowed) event.preventDefault();
        return;
      }
      // The browser's native contentEditable undo rewrites the DOM behind the
      // CRDT's back, and the resulting diff would be applied to the *merged*
      // text -- so it can revert a collaborator's edits. Always take it.
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) onRedo();
        else onUndo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        onRedo();
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        insertAtCaret('\n');
      }
    },
    [insertAtCaret, readOnly, onUndo, onRedo],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (readOnly) return;
      insertAtCaret(event.clipboardData.getData('text/plain'));
    },
    [insertAtCaret, readOnly],
  );

  const handleSelect = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const range = getSelectionRange(el);
    const caret = getCaretOffset(el);
    if (caret !== null) rememberCaret(caret);
    onCaret(caret ?? 0, range);
    onSelectionChange(range && range.end > range.start ? range : null);
  }, [onCaret, onSelectionChange, rememberCaret]);

  // ---------------------------------------------------------------------------
  // Remote awareness overlay
  // ---------------------------------------------------------------------------

  const overlay = useMemo(() => {
    void overlayTick;
    const el = ref.current;
    if (!el || !rga) return null;

    return peers.map((peer) => {
      const carets: React.ReactNode[] = [];

      if (peer.selection) {
        const start = peer.selection.startAfterId
          ? rga.indexOfId(peer.selection.startAfterId) + 1
          : 0;
        const end = peer.selection.endAfterId ? rga.indexOfId(peer.selection.endAfterId) + 1 : 0;
        if (end > start) {
          boxesForRange(el, start, end).forEach((box, i) => {
            carets.push(
              <div
                key={`sel-${peer.sessionId}-${i}`}
                className="remote-selection"
                style={{
                  top: box.top,
                  left: box.left,
                  width: box.width,
                  height: box.height,
                  background: peer.color,
                }}
              />,
            );
          });
        }
      }

      if (peer.cursor) {
        const index = peer.cursor.afterId ? rga.indexOfId(peer.cursor.afterId) + 1 : 0;
        const box = boxForOffset(el, index);
        if (box) {
          carets.push(
            <div
              key={`caret-${peer.sessionId}`}
              className="remote-caret"
              style={{ top: box.top, left: box.left, height: box.height, background: peer.color }}
            >
              <span className="remote-flag" style={{ background: peer.color }}>
                {peer.name}
              </span>
            </div>,
          );
        }
      }

      return <div key={peer.sessionId}>{carets}</div>;
    });
  }, [peers, rga, overlayTick]);

  return (
    <div style={{ position: 'relative' }}>
      <div className="overlay">{overlay}</div>
      <div
        ref={ref}
        className="doc-surface"
        data-readonly={readOnly}
        data-testid="editor"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onSelect={handleSelect}
        onKeyUp={handleSelect}
        onClick={handleSelect}
      >
        {runs.length === 0 ? (
          <span key="empty" />
        ) : (
          runs.map((run) => {
            const classes = [
              ...run.marks.map((m) => MARK_CLASS[m.type]).filter(Boolean),
              run.commentIds.length > 0 ? 'comment-anchor' : '',
              run.commentIds.includes(activeCommentId ?? '') ? 'merge-flash' : '',
            ]
              .filter(Boolean)
              .join(' ');

            const color = run.marks.find((m) => m.type === 'color')?.value;
            const authorColor = showAuthors && run.author ? authorColors[run.author] : undefined;
            const authorName = run.author ? authorNames[run.author] : undefined;

            return (
              <span
                key={`${run.from}-${run.text.length}`}
                className={classes || undefined}
                data-resolved={run.commentIds.length > 0 ? run.resolved : undefined}
                title={showAuthors && authorName ? `Written by ${authorName}` : undefined}
                style={{
                  ...(color ? { color } : {}),
                  ...(authorColor
                    ? { background: `${authorColor}33`, borderRadius: 2, boxShadow: `inset 0 -2px 0 ${authorColor}` }
                    : {}),
                }}
                onClick={
                  run.commentIds.length > 0 ? () => onCommentClick(run.commentIds[0]) : undefined
                }
              >
                {run.text}
              </span>
            );
          })
        )}
      </div>
      {readOnly && (
        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            color: 'var(--text-faint)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>&#128274;</span> You have view-only access. Editing is disabled.
        </div>
      )}
    </div>
  );
}
