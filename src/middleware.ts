import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Keeps the auth session fresh across navigations.
 *
 * Without this the access token expires and server-side reads quietly see no
 * user, which looks like being signed out at random. Calling `getUser()` is
 * what triggers the refresh; the response carries the rotated cookies back.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Without configuration there is no session to refresh; let the app render
  // and show its own setup guidance rather than failing every request here.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(items: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value } of items) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of items) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
