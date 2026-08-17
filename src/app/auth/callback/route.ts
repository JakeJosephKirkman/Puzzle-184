import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Where an emailed link lands.
 *
 * Supabase sends a one-time code; exchanging it sets the session cookies. This
 * is the first real caller of `getSupabaseServerClient()`, which until now was
 * defined and never used.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/';

  if (!code) {
    return NextResponse.redirect(new URL('/?auth=missing-code', url.origin));
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // Expired or already-used links are the common case, and worth naming
    // rather than dumping the user on a page that silently looks signed out.
    return NextResponse.redirect(new URL('/?auth=link-expired', url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
