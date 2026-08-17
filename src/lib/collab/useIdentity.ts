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

/**
 * Signs the visitor in anonymously and makes sure they have a profile.
 *
 * Anonymous sign-in still produces a real `auth.uid()`, which matters: every
 * permission check in this app is a row level security policy, and those need
 * a genuine authenticated identity to test against.
 */
export function useIdentity() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;

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
        }
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
    };
  }, []);

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

  return { identity, loading, error, rename };
}
