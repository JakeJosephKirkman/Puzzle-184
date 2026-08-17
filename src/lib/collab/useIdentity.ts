'use client';

import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { claimSessionId, colorForUser, generateDisplayName } from '@/lib/identity';
import type { Profile } from '@/types/database';

export interface Identity {
  user: User;
  profile: Profile;
  /** Identifies this browser tab. Two tabs of one account are two collaborators. */
  sessionId: string;
}

export type AccountState =
  | { kind: 'anonymous' }
  | { kind: 'pending'; email: string }
  | { kind: 'claimed'; email: string };

/**
 * Turn Supabase's auth errors into something a worried user can act on.
 *
 * A generic failure here is indistinguishable from "my documents are gone",
 * which is precisely the anxiety this feature exists to remove.
 */
function describeAuthError(message: string): string {
  const text = message.toLowerCase();
  if (text.includes('already') && text.includes('registered')) {
    return 'That email already belongs to another account. Sign in with it instead — but note this browser\u2019s current documents stay with the anonymous account.';
  }
  if (text.includes('rate') || text.includes('too many') || text.includes('60 seconds')) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  if (text.includes('invalid') && text.includes('email')) {
    return 'That does not look like a valid email address.';
  }
  if (text.includes('expired')) {
    return 'That link has expired. Request a new one.';
  }
  return message;
}

/**
 * Signs the visitor in anonymously and makes sure they have a profile.
 *
 * Anonymous sign-in still produces a real `auth.uid()`, which matters: every
 * permission check in this app is a row level security policy, and those need
 * a genuine authenticated identity to test against.
 */
/** Anonymous users carry `is_anonymous`; a confirmed email means the account is real. */
function accountStateOf(user: User): AccountState {
  const anonymous = (user as User & { is_anonymous?: boolean }).is_anonymous;
  if (user.email && !anonymous) return { kind: 'claimed', email: user.email };
  if (user.email) return { kind: 'pending', email: user.email };
  return { kind: 'anonymous' };
}

export function useIdentity() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<AccountState>({ kind: 'anonymous' });
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;
    let unsubscribe: (() => void) | null = null;

    (async () => {
      try {
        const supabase = getSupabaseBrowserClient();

        let {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          const { data, error: signInError } = await supabase.auth.signInAnonymously();
          if (signInError) throw signInError;
          user = data.user;
        }
        if (!user) throw new Error('Could not establish a session.');

        const { data: existing } = await supabase
          .from('collab_profiles')
          .select('*')
          .eq('id', user.id)
          .maybeSingle();

        let profile = existing as Profile | null;

        if (!profile) {
          const candidate = {
            id: user.id,
            display_name: generateDisplayName(),
            color: colorForUser(user.id),
          };
          const { data: created, error: insertError } = await supabase
            .from('collab_profiles')
            .insert(candidate)
            .select()
            .single();
          if (insertError) throw insertError;
          profile = created as Profile;
        }

        // Resolves a duplicated tab to a distinct id before presence starts.
        const claim = await claimSessionId();
        release = claim.release;

        if (!cancelled) {
          setIdentity({ user, profile, sessionId: claim.sessionId });
          setAccount(accountStateOf(user));
        }

        // The anonymous-to-permanent transition happens when the emailed link is
        // followed, often in another tab. Listening means this one updates
        // itself instead of needing a reload.
        const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
          if (cancelled || !session?.user) return;
          setIdentity((current) =>
            current ? { ...current, user: session.user } : current,
          );
          setAccount(accountStateOf(session.user));
        });
        unsubscribe = () => sub.subscription.unsubscribe();
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : 'Could not sign in. Is anonymous auth enabled?',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      release?.();
      unsubscribe?.();
    };
  }, []);

  /**
   * Attach an email to the *existing* anonymous user.
   *
   * The user id does not change, so every document, permission, operation and
   * comment carries over untouched -- there is nothing to migrate or merge,
   * because nothing moves. The account simply stops being anonymous once the
   * emailed link is followed.
   */
  const claimAccount = async (email: string) => {
    const supabase = getSupabaseBrowserClient();
    setAccountBusy(true);
    setAccountError(null);

    const { error: updateError } = await supabase.auth.updateUser(
      { email: email.trim() },
      { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(window.location.pathname)}` },
    );

    setAccountBusy(false);
    if (updateError) {
      setAccountError(describeAuthError(updateError.message));
      return false;
    }
    // Still anonymous until confirmed -- say so rather than claiming success.
    setAccount({ kind: 'pending', email: email.trim() });
    return true;
  };

  /** Send a sign-in link, to reach this account from another browser. */
  const sendSignInLink = async (email: string) => {
    const supabase = getSupabaseBrowserClient();
    setAccountBusy(true);
    setAccountError(null);

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: false,
      },
    });

    setAccountBusy(false);
    if (otpError) {
      setAccountError(describeAuthError(otpError.message));
      return false;
    }
    setAccount({ kind: 'pending', email: email.trim() });
    return true;
  };

  const signOut = async () => {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    window.location.reload();
  };

  const rename = async (name: string) => {
    if (!identity) return;
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase
      .from('collab_profiles')
      .update({ display_name: name, updated_at: new Date().toISOString() })
      .eq('id', identity.user.id)
      .select()
      .single();
    if (data) setIdentity({ ...identity, profile: data as Profile });
  };

  return {
    identity,
    loading,
    error,
    rename,
    account,
    accountError,
    accountBusy,
    claimAccount,
    sendSignInLink,
    signOut,
  };
}
