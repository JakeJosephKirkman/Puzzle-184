import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PresencePanel, TypingIndicator } from '../../src/components/PresencePanel';
import { ActivityFeed } from '../../src/components/ActivityFeed';
import { CommentsPanel } from '../../src/components/CommentsPanel';
import { VersionHistory } from '../../src/components/VersionHistory';
import type {
  ActivityRow,
  CommentRow,
  PresenceState,
  Profile,
  VersionRow,
} from '../../src/types/database';

const profiles: Record<string, Profile> = {
  'u-sarah': { id: 'u-sarah', display_name: 'Sarah Johnson', color: '#ec4899', created_at: '', updated_at: '' },
  'u-james': { id: 'u-james', display_name: 'James Smith', color: '#22c55e', created_at: '', updated_at: '' },
};

function peer(over: Partial<PresenceState> = {}): PresenceState {
  return {
    userId: 'u-sarah',
    sessionId: 'tab-1',
    name: 'Sarah Johnson',
    color: '#ec4899',
    role: 'editor',
    cursor: null,
    selection: null,
    typing: false,
    typingNearLine: null,
    onlineAt: new Date().toISOString(),
    ...over,
  };
}

function activity(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: Math.random().toString(36).slice(2),
    document_id: 'doc-1',
    actor_id: 'u-sarah',
    kind: 'edit',
    payload: {},
    bucket: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

function comment(over: Partial<CommentRow> = {}): CommentRow {
  return {
    id: 'c-1',
    document_id: 'doc-1',
    parent_id: null,
    author_id: 'u-james',
    body: 'Should we add more detail here?',
    anchor: null,
    resolved: false,
    resolved_by: null,
    resolved_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

function version(n: number, over: Partial<VersionRow> = {}): VersionRow {
  return {
    id: `v-${n}`,
    document_id: 'doc-1',
    version_number: n,
    content: `content of version ${n}`,
    crdt_snapshot: { nodes: [], marks: [], clock: 0 },
    created_by: 'u-sarah',
    label: null,
    summary: { edits: n * 3, sections: 4 },
    restored_from: null,
    created_at: new Date().toISOString(),
    ...over,
  };
}

describe('PresencePanel', () => {
  it('lists everyone online with their role, and counts them', () => {
    render(
      <PresencePanel
        peers={[
          peer({ sessionId: 'tab-1', name: 'Sarah Johnson' }),
          peer({ sessionId: 'tab-2', name: 'James Smith', userId: 'u-james', role: 'viewer' }),
        ]}
        selfSessionId="tab-9"
      />,
    );
    expect(screen.getByText('Currently online (2)')).toBeInTheDocument();
    expect(screen.getByText('Sarah Johnson')).toBeInTheDocument();
    expect(screen.getByText('James Smith')).toBeInTheDocument();
    expect(screen.getByText('Viewer')).toBeInTheDocument();
  });

  it('shows the local session as "You", pinned to the top', () => {
    render(
      <PresencePanel
        peers={[
          peer({ sessionId: 'tab-other', name: 'Aaron Early' }),
          peer({ sessionId: 'mine', name: 'Zoe Last' }),
        ]}
        selfSessionId="mine"
      />,
    );
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.queryByText('Zoe Last')).not.toBeInTheDocument();
    // "You" sorts ahead of a name that would otherwise come first alphabetically.
    const names = screen.getAllByText(/You|Aaron Early/).map((n) => n.textContent);
    expect(names[0]).toBe('You');
  });

  it('distinguishes editors from viewers', () => {
    render(<PresencePanel peers={[peer({ role: 'viewer' })]} selfSessionId={null} />);
    expect(screen.getByText('Viewing')).toBeInTheDocument();
    expect(screen.queryByText('Editing')).not.toBeInTheDocument();
  });
});

describe('TypingIndicator', () => {
  it('renders nothing when nobody is typing', () => {
    const { container } = render(<TypingIndicator peers={[peer({ typing: false })]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names who is typing and roughly where', () => {
    render(
      <TypingIndicator
        peers={[peer({ typing: true, typingNearLine: 7 }), peer({ sessionId: 'q', name: 'Quiet One' })]}
      />,
    );
    expect(screen.getByText('People are typing…')).toBeInTheDocument();
    expect(screen.getByText('Sarah Johnson')).toBeInTheDocument();
    expect(screen.getByText('Editing near line 7')).toBeInTheDocument();
    expect(screen.queryByText('Quiet One')).not.toBeInTheDocument();
  });
});

describe('ActivityFeed', () => {
  it('renders all six event kinds, correctly attributed', () => {
    render(
      <ActivityFeed
        profiles={profiles}
        limit={10}
        activity={[
          activity({ kind: 'edit', payload: { ops: 1 } }),
          activity({ kind: 'comment', payload: {} }),
          activity({ kind: 'join' }),
          activity({ kind: 'leave' }),
          activity({ kind: 'restore', payload: { restored_from_number: 6 } }),
          activity({ kind: 'permission', payload: { role: 'viewer' }, actor_id: 'u-james' }),
        ]}
      />,
    );
    expect(screen.getByText('edited the document')).toBeInTheDocument();
    expect(screen.getByText('added a comment')).toBeInTheDocument();
    expect(screen.getByText('joined the document')).toBeInTheDocument();
    expect(screen.getByText('left the document')).toBeInTheDocument();
    expect(screen.getByText('restored version 6')).toBeInTheDocument();
    expect(screen.getByText('changed a collaborator to viewer')).toBeInTheDocument();
    expect(screen.getAllByText('Sarah Johnson').length).toBe(5);
    expect(screen.getByText('James Smith')).toBeInTheDocument();
  });

  it('summarises a coalesced burst of edits as a single entry', () => {
    render(<ActivityFeed profiles={profiles} activity={[activity({ payload: { ops: 148 } })]} />);
    expect(screen.getByText('made 148 edits')).toBeInTheDocument();
  });

  it('distinguishes a reply from a new comment', () => {
    render(
      <ActivityFeed
        profiles={profiles}
        activity={[activity({ kind: 'comment', payload: { is_reply: true } })]}
      />,
    );
    expect(screen.getByText('replied to a comment')).toBeInTheDocument();
  });
});

describe('CommentsPanel', () => {
  const noop = () => {};
  const notOrphaned = () => false;

  it('shows a thread with the text it was written about', () => {
    render(
      <CommentsPanel
        comments={[comment({ anchor: { startId: '1:a', endId: '9:a', quotedText: 'handle conflicts' } })]}
        profiles={profiles}
        selection={null}
        selectedText=""
        activeCommentId={null}
        isOrphaned={notOrphaned}
        onAdd={noop}
        onResolve={noop}
        onFocusComment={noop}
      />
    );
    expect(screen.getByText('Comments (1)')).toBeInTheDocument();
    expect(screen.getByText(/handle conflicts/)).toBeInTheDocument();
    expect(screen.getByText('Should we add more detail here?')).toBeInTheDocument();
    expect(screen.getByText('James Smith')).toBeInTheDocument();
  });

  it('nests replies under their parent thread', () => {
    render(
      <CommentsPanel
        comments={[
          comment({ id: 'root' }),
          comment({ id: 'reply', parent_id: 'root', author_id: 'u-sarah', body: 'Good point, I will add a section.' }),
        ]}
        profiles={profiles}
        selection={null}
        selectedText=""
        activeCommentId={null}
        isOrphaned={notOrphaned}
        onAdd={noop}
        onResolve={noop}
        onFocusComment={noop}
      />
    );
    // One thread, with the reply rendered inside it rather than as a sibling.
    expect(screen.getByText('Comments (1)')).toBeInTheDocument();
    expect(screen.getByText('Good point, I will add a section.')).toBeInTheDocument();
  });

  it('resolves a thread, then offers to reopen it', async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <CommentsPanel
        comments={[comment()]} profiles={profiles} selection={null} selectedText=""
        activeCommentId={null} isOrphaned={notOrphaned} onAdd={noop}
        onResolve={onResolve} onFocusComment={noop}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(onResolve).toHaveBeenCalledWith('c-1', true);

    // Once resolved the thread hides, and the toggle brings it back as "Reopen".
    rerender(
      <CommentsPanel
        comments={[comment({ resolved: true })]} profiles={profiles} selection={null} selectedText=""
        activeCommentId={null} isOrphaned={notOrphaned} onAdd={noop}
        onResolve={onResolve} onFocusComment={noop}
      />
    );
    expect(screen.getByText('Comments (0)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show resolved' }));
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(onResolve).toHaveBeenCalledWith('c-1', false);
  });

  it('keeps a thread readable after its text is deleted', () => {
    // The anchor's characters are all tombstoned. The discussion must survive,
    // clearly marked, rather than silently disappearing.
    render(
      <CommentsPanel
        comments={[comment({ anchor: { startId: '1:a', endId: '9:a', quotedText: 'deleted sentence' } })]}
        profiles={profiles} selection={null} selectedText="" activeCommentId={null}
        isOrphaned={() => true} onAdd={noop} onResolve={noop} onFocusComment={noop}
      />
    );
    expect(screen.getByText(/On deleted text:/)).toBeInTheDocument();
    expect(screen.getByText(/deleted sentence/)).toBeInTheDocument();
    expect(screen.getByText('Should we add more detail here?')).toBeInTheDocument();
  });

  it('posts a comment against the current selection', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(
      <CommentsPanel
        comments={[]} profiles={profiles} selection={{ start: 10, end: 26 }}
        selectedText="handle conflicts" activeCommentId={null} isOrphaned={notOrphaned}
        onAdd={onAdd} onResolve={noop} onFocusComment={noop}
      />
    );
    expect(screen.getByText(/Commenting on/)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Add a comment…'), 'Is this right?');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    expect(onAdd).toHaveBeenCalledWith('Is this right?', { start: 10, end: 26 });
  });
});

describe('VersionHistory', () => {
  const noop = () => {};

  it('renders the whole timeline and details the selected version', () => {
    render(
      <VersionHistory
        versions={[version(1), version(2), version(3)]}
        profiles={profiles}
        canEdit
        currentContent="something else entirely"
        onRestore={noop}
        onSaveVersion={noop}
      />,
    );
    expect(screen.getByText('Version history')).toBeInTheDocument();
    expect(screen.getAllByText('v1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('v3').length).toBeGreaterThan(0);
    // Latest is selected by default and marked as current.
    expect(screen.getByText(/Version 3 \(Current\)/)).toBeInTheDocument();
    expect(screen.getByText('Sarah Johnson')).toBeInTheDocument();
    expect(screen.getByText('9 edits')).toBeInTheDocument();
  });

  it('previews an older version without touching the live document', async () => {
    const onRestore = vi.fn();
    const user = userEvent.setup();
    render(
      <VersionHistory
        versions={[version(1), version(2)]} profiles={profiles} canEdit
        currentContent="live text" onRestore={onRestore} onSaveVersion={noop}
      />,
    );
    await user.click(screen.getAllByText('v1')[0]);
    expect(screen.getByText('Version 1')).toBeInTheDocument();
    expect(screen.getByText(/content of version 1/)).toBeInTheDocument();
    expect(onRestore).not.toHaveBeenCalled(); // selecting is not restoring
  });

  it('restores the selected version on request', async () => {
    const onRestore = vi.fn();
    const user = userEvent.setup();
    render(
      <VersionHistory
        versions={[version(1), version(2)]} profiles={profiles} canEdit
        currentContent="live text" onRestore={onRestore} onSaveVersion={noop}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Restore/ }));
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ version_number: 2 }));
  });

  it('disables restore when the version already matches the document', () => {
    render(
      <VersionHistory
        versions={[version(1)]} profiles={profiles} canEdit
        currentContent="content of version 1" onRestore={noop} onSaveVersion={noop}
      />,
    );
    expect(screen.getByRole('button', { name: /Restore/ })).toBeDisabled();
  });

  it('does not offer restore or save to a viewer', () => {
    render(
      <VersionHistory
        versions={[version(1)]} profiles={profiles} canEdit={false}
        currentContent="live text" onRestore={noop} onSaveVersion={noop}
      />,
    );
    expect(screen.getByRole('button', { name: /Restore/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save version' })).toBeDisabled();
  });
});
