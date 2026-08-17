'use client';

import { useState } from 'react';
import type { AccountState } from '@/lib/collab/useIdentity';

/**
 * Optional account upgrade.
 *
 * Anonymous access stays the default -- it is what makes the app usable in one
 * click, and what makes the two-window demo work. This only offers a way out of
 * the corner that identity is otherwise painted into: an account that exists
 * solely in one browser's localStorage cannot be reached from anywhere else,
 * and cannot be recovered if that storage is cleared.
 */
export function AccountPanel({
  account,
  error,
  busy,
  ownedDocumentCount,
  onClaim,
  onSignIn,
  onSignOut,
}: {
  account: AccountState;
  error: string | null;
  busy: boolean;
  /** Documents owned by the current anonymous user, which signing in would strand. */
  ownedDocumentCount: number;
  onClaim: (email: string) => Promise<boolean>;
  onSignIn: (email: string) => Promise<boolean>;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'claim' | 'signin'>('claim');
  const [email, setEmail] = useState('');
  const [acknowledgedStranding, setAcknowledgedStranding] = useState(false);

  if (account.kind === 'claimed') {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
        <div style={{ marginBottom: 4 }}>Signed in as {account.email}</div>
        <button
          className="btn"
          style={{ padding: '3px 8px', fontSize: 11 }}
          onClick={onSignOut}
        >
          Sign out
        </button>
      </div>
    );
  }

  if (account.kind === 'pending') {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--text)' }}>Check your email</strong>
        <div>
          A link is on its way to {account.email}. Your documents stay exactly where they are
          until you follow it.
        </div>
      </div>
    );
  }

  // The trap this guards: signing in on a device that already has an anonymous
  // user abandons that user, and any documents only they own become
  // unreachable -- the very failure accounts are meant to fix.
  const wouldStrand = mode === 'signin' && ownedDocumentCount > 0;

  return (
    <div style={{ fontSize: 11 }}>
      {!open ? (
        <button
          className="btn"
          style={{ padding: '4px 9px', fontSize: 11, width: '100%', justifyContent: 'center' }}
          onClick={() => setOpen(true)}
        >
          Save your account
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className="btn"
              style={{
                padding: '3px 7px',
                fontSize: 10.5,
                flex: 1,
                justifyContent: 'center',
                background: mode === 'claim' ? 'var(--accent)' : undefined,
                borderColor: mode === 'claim' ? 'var(--accent)' : undefined,
              }}
              onClick={() => setMode('claim')}
            >
              Save this account
            </button>
            <button
              className="btn"
              style={{
                padding: '3px 7px',
                fontSize: 10.5,
                flex: 1,
                justifyContent: 'center',
                background: mode === 'signin' ? 'var(--accent)' : undefined,
                borderColor: mode === 'signin' ? 'var(--accent)' : undefined,
              }}
              onClick={() => setMode('signin')}
            >
              Sign in
            </button>
          </div>

          <p style={{ margin: 0, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            {mode === 'claim'
              ? 'Attach an email so you can reach these documents from another browser. Nothing moves — the account you already have simply gains an email.'
              : 'Already have an account? We will email you a sign-in link.'}
          </p>

          {wouldStrand && (
            <div
              role="alert"
              style={{
                background: 'rgba(245, 158, 11, 0.12)',
                border: '1px solid var(--amber)',
                borderRadius: 8,
                padding: 8,
                color: 'var(--text-muted)',
                lineHeight: 1.5,
              }}
            >
              You own {ownedDocumentCount} document{ownedDocumentCount === 1 ? '' : 's'} on this
              browser as a guest. Signing in as someone else leaves{' '}
              {ownedDocumentCount === 1 ? 'it' : 'them'} behind, with no way back.
              <label style={{ display: 'flex', gap: 6, marginTop: 7, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={acknowledgedStranding}
                  onChange={(e) => setAcknowledgedStranding(e.target.checked)}
                />
                I understand
              </label>
            </div>
          )}

          <input
            className="input"
            type="email"
            value={email}
            placeholder="you@example.com"
            aria-label="Email address"
            style={{ fontSize: 12 }}
            onChange={(e) => setEmail(e.target.value)}
          />

          {error && (
            <div role="alert" style={{ color: 'var(--red)', lineHeight: 1.5 }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 5 }}>
            <button
              className="btn btn-primary"
              style={{ padding: '4px 9px', fontSize: 11, flex: 1, justifyContent: 'center' }}
              disabled={busy || !email.trim() || (wouldStrand && !acknowledgedStranding)}
              onClick={() => void (mode === 'claim' ? onClaim(email) : onSignIn(email))}
            >
              {busy ? 'Sending…' : 'Send link'}
            </button>
            <button
              className="btn"
              style={{ padding: '4px 9px', fontSize: 11 }}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
