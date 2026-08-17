'use client';

import type { MarkType } from '@/lib/crdt/types';

const BUTTONS: { type: MarkType; label: string; title: string; style?: React.CSSProperties }[] = [
  { type: 'heading1', label: 'H1', title: 'Heading 1' },
  { type: 'heading2', label: 'H2', title: 'Heading 2' },
  { type: 'heading3', label: 'H3', title: 'Heading 3' },
  { type: 'bold', label: 'B', title: 'Bold', style: { fontWeight: 800 } },
  { type: 'italic', label: 'I', title: 'Italic', style: { fontStyle: 'italic' } },
  { type: 'underline', label: 'U', title: 'Underline', style: { textDecoration: 'underline' } },
  { type: 'code', label: '</>', title: 'Code' },
  { type: 'highlight', label: '🖍', title: 'Highlight' },
];

export function Toolbar({
  disabled,
  hasSelection,
  canUndo,
  canRedo,
  showAuthors,
  onUndo,
  onRedo,
  onToggleAuthors,
  onMark,
  onComment,
}: {
  disabled: boolean;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  showAuthors: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onToggleAuthors: () => void;
  onMark: (type: MarkType) => void;
  onComment: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        flexWrap: 'wrap',
      }}
    >
      <button
        className="btn"
        disabled={disabled || !canUndo}
        onClick={onUndo}
        title="Undo your last change (⌘Z)"
        style={{ padding: '4px 9px', fontSize: 12 }}
      >
        ↶
      </button>
      <button
        className="btn"
        disabled={disabled || !canRedo}
        onClick={onRedo}
        title="Redo (⌘⇧Z)"
        style={{ padding: '4px 9px', fontSize: 12 }}
      >
        ↷
      </button>

      <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 6px' }} />

      {BUTTONS.map((button) => (
        <button
          key={button.type}
          className="btn"
          title={
            disabled
              ? 'View-only access'
              : hasSelection
                ? button.title
                : 'Select text first'
          }
          disabled={disabled || !hasSelection}
          onClick={() => onMark(button.type)}
          style={{
            padding: '4px 9px',
            fontSize: 12,
            minWidth: 32,
            justifyContent: 'center',
            ...button.style,
          }}
        >
          {button.label}
        </button>
      ))}

      <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 6px' }} />

      <button
        className="btn"
        onClick={onToggleAuthors}
        title="Colour the text by who wrote it"
        style={{
          padding: '4px 9px',
          fontSize: 12,
          background: showAuthors ? 'var(--accent)' : undefined,
          borderColor: showAuthors ? 'var(--accent)' : undefined,
          color: showAuthors ? '#fff' : undefined,
        }}
      >
        Authors
      </button>

      <button
        className="btn"
        disabled={!hasSelection}
        onClick={onComment}
        title={hasSelection ? 'Comment on selection' : 'Select text to comment'}
        style={{ padding: '4px 9px', fontSize: 12 }}
      >
        💬 Comment
      </button>
    </div>
  );
}
