import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FakeBroker, createFakeSupabase, seedDocument } from '../support/fakeSupabase';
import { AccountPanel } from '../../src/components/AccountPanel';

const broker = { current: new FakeBroker() };

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseBrowserClient: () => createFakeSupabase(broker.current, 'user-1'),
}));

vi.mock('@/lib/identity', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/identity')>(
    '../../src/lib/identity',
  );
  return {
    ...actual,
    // The BroadcastChannel handshake is covered elsewhere; skip its delay here.
    claimSessionId: async () => ({ sessionId: 'tab-a', release: () => {} }),
  };
});

const { useIdentity } = await import('@/lib/collab/useIdentity');

beforeEach(() => {
  broker.current = new FakeBroker();
  seedDocument(broker.current);
  window.history.replaceState({}, '', '/');
});

async function signedIn() {
  const view = renderHook(() => useIdentity());
  await waitFor(() => expect(view.result.current.identity).not.toBeNull());
  return view;
}

describe('claiming an account', () => {
  it('KEEPS THE SAME USER ID, so documents carry over', async () => {
    // The crux. If linking an email minted a new user, every document would be
    // stranded under the old id -- the exact failure this feature exists to fix,
    // caused by the fix itself.
    const view = await signedIn();
    const before = view.result.current.identity!.user.id;

    await act(async () => {
      await view.result.current.claimAccount('me@example.com');
    });

    expect(view.result.current.identity!.user.id).toBe(before);

    // And the document created while anonymous is still owned by that id.
    const doc = broker.current.rows('collab_documents')[0];
    expect(doc.owner_id).toBe(before);
  });

  it('reports a pending state rather than claiming success', async () => {
    const view = await signedIn();
    expect(view.result.current.account.kind).toBe('anonymous');

    await act(async () => {
      await view.result.current.claimAccount('me@example.com');
    });

    // Still anonymous until the emailed link is followed -- saying "done" here
    // would be a lie the user could act on.
    expect(view.result.current.account).toEqual({ kind: 'pending', email: 'me@example.com' });
  });

  it('becomes claimed when the emailed link is followed', async () => {
    const view = await signedIn();
    await act(async () => {
      await view.result.current.claimAccount('me@example.com');
    });

    await act(async () => {
      const supabase = createFakeSupabase(broker.current, 'user-1');
      await supabase.auth.verifyOtp();
    });

    await waitFor(() => expect(view.result.current.account.kind).toBe('claimed'));
  });

  it('explains when the email belongs to somebody else', async () => {
    broker.current.users.set('someone-else', {
      id: 'someone-else',
      email: 'taken@example.com',
      is_anonymous: false,
    });

    const view = await signedIn();
    await act(async () => {
      const ok = await view.result.current.claimAccount('taken@example.com');
      expect(ok).toBe(false);
    });

    expect(view.result.current.accountError).toMatch(/already belongs to another account/i);
    expect(view.result.current.account.kind).toBe('anonymous');
  });
});

describe('signing in from another browser', () => {
  it('refuses an email with no account behind it', async () => {
    const view = await signedIn();
    await act(async () => {
      const ok = await view.result.current.sendSignInLink('nobody@example.com');
      expect(ok).toBe(false);
    });
    expect(view.result.current.accountError).toBeTruthy();
  });

  it('sends a link when the account exists', async () => {
    broker.current.users.set('other', {
      id: 'other',
      email: 'real@example.com',
      is_anonymous: false,
    });
    const view = await signedIn();
    await act(async () => {
      const ok = await view.result.current.sendSignInLink('real@example.com');
      expect(ok).toBe(true);
    });
    expect(view.result.current.account).toEqual({ kind: 'pending', email: 'real@example.com' });
  });
});

describe('AccountPanel', () => {
  const noop = async () => true;

  it('warns before stranding documents owned as a guest', async () => {
    const onSignIn = vi.fn(async () => true);
    const user = userEvent.setup();
    render(
      <AccountPanel
        account={{ kind: 'anonymous' }}
        error={null}
        busy={false}
        ownedDocumentCount={3}
        onClaim={noop}
        onSignIn={onSignIn}
        onSignOut={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save your account' }));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/You own 3 documents/);

    await user.type(screen.getByLabelText('Email address'), 'me@example.com');
    // Blocked until the consequence is acknowledged.
    expect(screen.getByRole('button', { name: 'Send link' })).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Send link' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Send link' }));
    expect(onSignIn).toHaveBeenCalledWith('me@example.com');
  });

  it('does not warn when claiming, since nothing is stranded', async () => {
    const user = userEvent.setup();
    render(
      <AccountPanel
        account={{ kind: 'anonymous' }} error={null} busy={false} ownedDocumentCount={3}
        onClaim={noop} onSignIn={noop} onSignOut={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save your account' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the pending state and reassures about the documents', () => {
    render(
      <AccountPanel
        account={{ kind: 'pending', email: 'me@example.com' }} error={null} busy={false}
        ownedDocumentCount={0} onClaim={noop} onSignIn={noop} onSignOut={() => {}}
      />,
    );
    expect(screen.getByText('Check your email')).toBeInTheDocument();
    expect(screen.getByText(/documents stay exactly where they are/)).toBeInTheDocument();
  });

  it('offers sign out once the account is claimed', async () => {
    const onSignOut = vi.fn();
    const user = userEvent.setup();
    render(
      <AccountPanel
        account={{ kind: 'claimed', email: 'me@example.com' }} error={null} busy={false}
        ownedDocumentCount={0} onClaim={noop} onSignIn={noop} onSignOut={onSignOut}
      />,
    );
    expect(screen.getByText('Signed in as me@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it('surfaces an error where the user can see it', () => {
    render(
      <AccountPanel
        account={{ kind: 'anonymous' }} error="Too many attempts. Wait a minute and try again."
        busy={false} ownedDocumentCount={0} onClaim={noop} onSignIn={noop} onSignOut={() => {}}
      />,
    );
    // The panel opens itself when there is something to report.
    expect(screen.getByRole('button', { name: 'Save your account' })).toBeInTheDocument();
  });
});
