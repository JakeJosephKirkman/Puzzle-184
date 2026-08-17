import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { FakeBroker, createFakeSupabase, seedDocument } from '../support/fakeSupabase';

/**
 * The collaboration hook, driven by two instances against one shared broker --
 * the two-tab scenario without a WebSocket.
 *
 * These prove the hook's own logic given a well-behaved transport. They do not
 * prove Supabase's wire behaviour (heartbeat eviction, real reconnection,
 * Postgres Changes latency); that is what the Playwright suite is for.
 */

const broker = { current: new FakeBroker() };

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseBrowserClient: () => createFakeSupabase(broker.current, currentUser.id),
}));

const currentUser = { id: 'user-1' };

// Imported after the mock so the hook picks up the double.
const { useCollabDocument } = await import('@/lib/collab/useCollabDocument');

function identity(sessionId: string, userId = 'user-1', name = 'Tester') {
  return {
    user: { id: userId } as never,
    profile: {
      id: userId, display_name: name, color: '#8b7bf7',
      created_at: '', updated_at: '',
    },
    sessionId,
  };
}

async function openDocument(sessionId: string, userId = 'user-1', name = 'Tester') {
  currentUser.id = userId;
  const view = renderHook(() => useCollabDocument('doc-1', identity(sessionId, userId, name)));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

beforeEach(() => {
  broker.current = new FakeBroker();
  currentUser.id = 'user-1';
  seedDocument(broker.current);
});

afterEach(() => vi.useRealTimers());

describe('channel lifecycle (#12)', () => {
  it('opens exactly one channel per document and tears it down on unmount', async () => {
    const view = await openDocument('tab-a');
    expect(broker.current.peersOf('doc:doc-1')).toHaveLength(1);

    view.unmount();
    await waitFor(() => expect(broker.current.peersOf('doc:doc-1')).toHaveLength(0));
  });

  it('does not duplicate the channel when the same document is reopened', async () => {
    const first = await openDocument('tab-a');
    first.unmount();
    const second = await openDocument('tab-a');
    expect(broker.current.peersOf('doc:doc-1')).toHaveLength(1);
    second.unmount();
  });
});

describe('presence (#13, #18)', () => {
  it('shows both sessions to each other', async () => {
    const a = await openDocument('tab-a', 'user-1', 'Alice');
    const b = await openDocument('tab-b', 'user-2', 'Bob');

    await waitFor(() => {
      expect(a.result.current.allPeers.length).toBe(2);
      expect(b.result.current.allPeers.length).toBe(2);
    });
    expect(a.result.current.peers.map((p) => p.name)).toContain('Bob');
  });

  it('removes a session that disconnects without saying goodbye', async () => {
    const a = await openDocument('tab-a', 'user-1', 'Alice');
    await openDocument('tab-b', 'user-2', 'Bob');
    await waitFor(() => expect(a.result.current.allPeers.length).toBe(2));

    // Killed tab: no untrack, just gone.
    act(() => broker.current.disconnect('tab-b'));

    await waitFor(() => expect(a.result.current.allPeers.length).toBe(1));
    expect(a.result.current.peers).toHaveLength(0);
  });
});

describe('operation delivery and dedupe (#16)', () => {
  it('propagates an edit to the other session', async () => {
    const a = await openDocument('tab-a', 'user-1', 'Alice');
    const b = await openDocument('tab-b', 'user-2', 'Bob');
    await waitFor(() => expect(b.result.current.allPeers.length).toBe(2));

    act(() => a.result.current.actions.applyText('hello', 5));

    await waitFor(() => expect(b.result.current.text).toBe('hello'));
  });

  it('applies an operation ONCE even though it arrives on both transports', async () => {
    // The dedupe claim the whole design rests on: broadcast is fast but lossy,
    // postgres_changes is durable but slower, and every operation travels both.
    // Without idempotent apply this would render "hellohello".
    const a = await openDocument('tab-a', 'user-1', 'Alice');
    const b = await openDocument('tab-b', 'user-2', 'Bob');
    await waitFor(() => expect(b.result.current.allPeers.length).toBe(2));

    act(() => a.result.current.actions.applyText('hello', 5));
    await waitFor(() => expect(b.result.current.text).toBe('hello'));

    // Every operation is now in collab_operations too, and B's postgres_changes
    // listener received each insert as it happened.
    const ops = broker.current.rows('collab_operations');
    expect(ops.length).toBe(5);
    expect(b.result.current.text).toBe('hello');
  });

  it('keeps both users\' characters when they type into the same sentence', async () => {
    const a = await openDocument('tab-a', 'user-1', 'Alice');
    const b = await openDocument('tab-b', 'user-2', 'Bob');
    await waitFor(() => expect(b.result.current.allPeers.length).toBe(2));

    act(() => a.result.current.actions.applyText('The fox', 7));
    await waitFor(() => expect(b.result.current.text).toBe('The fox'));

    // Hold delivery so neither sees the other's edit before making their own.
    // Without this the second call diffs against text that already contains the
    // first edit, which is a sequential overwrite and proves nothing.
    broker.current.pause();
    act(() => {
      a.result.current.actions.applyText('The quick fox', 10);
      b.result.current.actions.applyText('The brown fox', 10);
    });
    await act(async () => { broker.current.resume(); });

    await waitFor(() => {
      expect(a.result.current.text).toBe(b.result.current.text);
    });
    expect(a.result.current.text).toContain('quick');
    expect(a.result.current.text).toContain('brown');
  });
});

describe('persistence (#19)', () => {
  it('writes every operation durably as it happens', async () => {
    const a = await openDocument('tab-a');
    act(() => a.result.current.actions.applyText('abc', 3));
    await waitFor(() => expect(broker.current.rows('collab_operations').length).toBe(3));
  });

  it('debounces the snapshot instead of saving per keystroke', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const a = await openDocument('tab-a');
    const doc = () => broker.current.rows('collab_documents')[0];
    const versionBefore = doc().snapshot_version;

    await act(async () => {
      a.result.current.actions.applyText('a', 1);
      a.result.current.actions.applyText('ab', 2);
      a.result.current.actions.applyText('abc', 3);
    });

    // Advance well short of SAVE_DEBOUNCE_MS (1500). Asserting immediately here
    // would prove nothing -- even an undebounced save runs on a 0ms timer and
    // would not have fired yet, so the test would pass with the debounce gone.
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(doc().snapshot_version).toBe(versionBefore);

    // Past the window: exactly one save for all three keystrokes, not three.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await waitFor(() => expect(doc().snapshot_version).toBe(versionBefore + 1));
    expect(doc().content).toBe('abc');
  });
});

describe('conflict awareness (#21)', () => {
  it('flags a remote edit landing next to the local cursor', async () => {
    const a = await openDocument('tab-a', 'user-1', 'Alice');
    const b = await openDocument('tab-b', 'user-2', 'Bob');
    await waitFor(() => expect(b.result.current.allPeers.length).toBe(2));

    act(() => a.result.current.actions.applyText('shared sentence', 15));
    await waitFor(() => expect(b.result.current.text).toBe('shared sentence'));

    // Alice types, then Bob edits within the proximity window.
    act(() => a.result.current.actions.applyText('shared sentence!', 16));
    act(() => b.result.current.actions.applyText('shared sentence!?', 17));

    await waitFor(() => expect(a.result.current.conflicts.length).toBeGreaterThan(0));
    expect(a.result.current.conflicts[0].name).toBe('Bob');
  });

  it('stays quiet when the local user has not been typing', async () => {
    const a = await openDocument('tab-a', 'user-1', 'Alice');
    const b = await openDocument('tab-b', 'user-2', 'Bob');
    await waitFor(() => expect(b.result.current.allPeers.length).toBe(2));

    // Only Bob edits; Alice is idle, so there is nothing to warn her about.
    act(() => b.result.current.actions.applyText('bob was here', 12));
    await waitFor(() => expect(a.result.current.text).toBe('bob was here'));
    expect(a.result.current.conflicts).toHaveLength(0);
  });
});

describe('versions (#22)', () => {
  it('captures a version automatically after a long burst of editing', async () => {
    const a = await openDocument('tab-a');
    expect(broker.current.rows('collab_versions')).toHaveLength(0);

    // AUTO_VERSION_EVERY_OPS is 50; 60 characters crosses it.
    const text = 'x'.repeat(60);
    await act(async () => { a.result.current.actions.applyText(text, text.length); });

    await waitFor(() => expect(broker.current.rows('collab_versions').length).toBeGreaterThan(0));
    const version = broker.current.rows('collab_versions')[0];
    expect(version.created_by).toBe('user-1');
    expect(version.content).toBe(text);
  });

  it('records a manual version with its author', async () => {
    const a = await openDocument('tab-a');
    act(() => a.result.current.actions.applyText('some content', 12));
    await act(async () => { await a.result.current.actions.createVersion('Manual save'); });

    const versions = broker.current.rows('collab_versions');
    expect(versions).toHaveLength(1);
    expect(versions[0].label).toBe('Manual save');
    expect(versions[0].created_by).toBe('user-1');
  });
});

describe('permissions (#28)', () => {
  it('goes read-only the moment the user is demoted mid-session', async () => {
    const a = await openDocument('tab-a');
    expect(a.result.current.canEdit).toBe(true);

    act(() => a.result.current.actions.applyText('before demotion', 15));
    await waitFor(() => expect(a.result.current.text).toBe('before demotion'));

    // The owner demotes them; the permission row change is broadcast.
    await act(async () => {
      const perm = broker.current.rows('collab_permissions').find((p) => p.user_id === 'user-1');
      perm!.role = 'viewer';
      broker.current.emitChange('collab_permissions', 'UPDATE', perm!);
    });

    await waitFor(() => expect(a.result.current.canEdit).toBe(false));

    // Further edits are refused, not merely hidden behind a disabled button.
    act(() => a.result.current.actions.applyText('sneaky edit', 11));
    expect(a.result.current.text).toBe('before demotion');
  });
});
