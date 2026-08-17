'use client';

import Link from 'next/link';
import { Avatar } from './Avatar';
import { SyncStatus } from './SyncStatus';
import { AccountPanel } from './AccountPanel';
import type { AccountState } from '@/lib/collab/useIdentity';
import type { ConnectionState } from '@/types/database';
import type { Identity } from '@/lib/collab/useIdentity';

const NAV = [
  { label: 'Dashboard', icon: '⌂', href: '/' },
  { label: 'Documents', icon: '📄', href: '/' },
];

export function Sidebar({
  identity,
  connection,
  pending,
  onNewDocument,
  onRename,
  account,
  accountError,
  accountBusy,
  ownedDocumentCount = 0,
  onClaimAccount,
  onSignInLink,
  onSignOut,
  active = 'Documents',
}: {
  identity: Identity | null;
  connection?: ConnectionState;
  pending?: number;
  onNewDocument?: () => void;
  onRename?: (name: string) => void;
  account?: AccountState;
  accountError?: string | null;
  accountBusy?: boolean;
  ownedDocumentCount?: number;
  onClaimAccount?: (email: string) => Promise<boolean>;
  onSignInLink?: (email: string) => Promise<boolean>;
  onSignOut?: () => void;
  active?: string;
}) {
  return (
    <aside
      className="app-sidebar"
      aria-label="Workspace navigation"
      style={{
        width: 216,
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
        padding: 14,
        gap: 14,
        height: '100vh',
        position: 'sticky',
        top: 0,
      }}
    >
      <Link
        href="/"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          textDecoration: 'none',
          color: 'var(--text)',
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: 'var(--accent)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            fontSize: 13,
          }}
        >
          C
        </span>
        <span className="sidebar-label" style={{ fontWeight: 700, fontSize: 15 }}>
          CollabSpace
        </span>
      </Link>

      {onNewDocument && (
        <button className="btn btn-primary" style={{ justifyContent: 'center' }} onClick={onNewDocument}>
          + New Document
        </button>
      )}

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '7px 9px',
              borderRadius: 8,
              fontSize: 13,
              textDecoration: 'none',
              color: active === item.label ? 'var(--text)' : 'var(--text-muted)',
              background: active === item.label ? 'var(--surface-3)' : 'transparent',
            }}
          >
            <span style={{ fontSize: 13 }} aria-hidden="true">{item.icon}</span>
            <span className="sidebar-label">{item.label}</span>
          </Link>
        ))}
      </nav>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {connection && <SyncStatus connection={connection} pending={pending ?? 0} />}

        {identity && account && onClaimAccount && onSignInLink && onSignOut && (
          <div className="sidebar-label" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <AccountPanel
              account={account}
              error={accountError ?? null}
              busy={accountBusy ?? false}
              ownedDocumentCount={ownedDocumentCount}
              onClaim={onClaimAccount}
              onSignIn={onSignInLink}
              onSignOut={onSignOut}
            />
          </div>
        )}

        {identity && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              borderTop: '1px solid var(--border)',
              paddingTop: 12,
            }}
          >
            <Avatar name={identity.profile.display_name} color={identity.profile.color} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {onRename ? (
                <input
                  defaultValue={identity.profile.display_name}
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (value && value !== identity.profile.display_name) onRename(value);
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text)',
                    fontSize: 12.5,
                    fontWeight: 600,
                    padding: 0,
                    width: '100%',
                    outline: 'none',
                  }}
                />
              ) : (
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {identity.profile.display_name}
                </div>
              )}
              <div className="sidebar-label" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                session {identity.sessionId.slice(0, 8)}
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
