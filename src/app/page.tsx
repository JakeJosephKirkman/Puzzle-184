'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sidebar } from '@/components/Sidebar';
import { useIdentity } from '@/lib/collab/useIdentity';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { relativeTime } from '@/lib/time';
import { roleLabel } from '@/lib/identity';
import type { DocRole, DocumentRow } from '@/types/database';

interface DocumentWithRole extends DocumentRow {
  role: DocRole | null;
}

/** Reports what happened when an emailed link was followed. */
function AuthNotice() {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get('auth');
    if (status === 'link-expired') {
      setNotice('That sign-in link has expired or was already used. Request a new one.');
    } else if (status === 'missing-code') {
      setNotice('That link was incomplete. Request a new one.');
    }
  }, []);

  if (!notice) return null;
  return (
    <div
      role="alert"
      className="panel"
      style={{ padding: 12, borderColor: 'var(--amber)', marginBottom: 18, fontSize: 12.5 }}
    >
      {notice}
    </div>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const {
    identity, loading, error, rename,
    account, accountError, accountBusy, claimAccount, sendSignInLink, signOut,
  } = useIdentity();
  const [documents, setDocuments] = useState<DocumentWithRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!identity) return;
    const supabase = getSupabaseBrowserClient();

    // RLS means this returns only documents we hold a permission row for.
    const { data: permissions, error: permError } = await supabase
      .from('collab_permissions')
      .select('document_id, role')
      .eq('user_id', identity.user.id);

    if (permError) {
      setListError(permError.message);
      return;
    }

    const ids = (permissions ?? []).map((p) => (p as { document_id: string }).document_id);
    if (ids.length === 0) {
      setDocuments([]);
      return;
    }

    const { data: docs } = await supabase
      .from('collab_documents')
      .select('*')
      .in('id', ids)
      .order('updated_at', { ascending: false });

    const roleById = new Map(
      (permissions ?? []).map((p) => {
        const row = p as { document_id: string; role: DocRole };
        return [row.document_id, row.role];
      }),
    );

    setDocuments(
      ((docs ?? []) as DocumentRow[]).map((d) => ({ ...d, role: roleById.get(d.id) ?? null })),
    );
  }, [identity]);

  useEffect(() => {
    void load();
  }, [load]);

  const createDocument = async () => {
    if (!identity || busy) return;
    setBusy(true);
    const supabase = getSupabaseBrowserClient();
    const { data, error: rpcError } = await supabase.rpc('collab_create_document', {
      doc_title: 'Untitled document',
    });
    setBusy(false);
    if (rpcError) {
      setListError(rpcError.message);
      return;
    }
    router.push(`/doc/${data as string}`);
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar
        identity={identity}
        onNewDocument={createDocument}
        onRename={rename}
        account={account}
        accountError={accountError}
        accountBusy={accountBusy}
        ownedDocumentCount={documents.filter((d) => d.role === 'owner').length}
        onClaimAccount={claimAccount}
        onSignInLink={sendSignInLink}
        onSignOut={signOut}
      />

      <main style={{ flex: 1, padding: '32px 36px', maxWidth: 1000 }}>
        <h1 style={{ margin: '0 0 6px', fontSize: 24 }}>Documents</h1>
        <p style={{ margin: '0 0 26px', fontSize: 13, color: 'var(--text-muted)' }}>
          Create a document, then open its link in a second browser window to collaborate.
        </p>

        {loading && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Signing you in…</p>}

        <AuthNotice />

        {(error || listError) && (
          <div
            className="panel"
            style={{ padding: 16, borderColor: 'var(--red)', marginBottom: 20 }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              Could not reach Supabase
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {error || listError}
              <br />
              Check that <code>.env.local</code> has your project URL and anon key, that the
              migrations in <code>supabase/migrations</code> have been applied, and that anonymous
              sign-ins are enabled.
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gap: 10 }}>
          {documents.map((document) => (
            <Link
              key={document.id}
              href={`/doc/${document.id}`}
              className="panel"
              style={{
                padding: 16,
                textDecoration: 'none',
                color: 'var(--text)',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
              }}
            >
              <span style={{ fontSize: 20 }}>📄</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{document.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 3 }}>
                  Edited {relativeTime(document.updated_at)} · {document.content.length} characters
                </div>
              </div>
              <span
                style={{
                  fontSize: 11,
                  padding: '3px 9px',
                  borderRadius: 999,
                  background: 'var(--surface-3)',
                  color: 'var(--text-muted)',
                }}
              >
                {roleLabel(document.role)}
              </span>
            </Link>
          ))}

          {!loading && documents.length === 0 && !error && (
            <div className="panel" style={{ padding: 28, textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No documents yet</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16 }}>
                Create one to start collaborating.
              </div>
              <button className="btn btn-primary" onClick={createDocument} disabled={busy}>
                + New Document
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
