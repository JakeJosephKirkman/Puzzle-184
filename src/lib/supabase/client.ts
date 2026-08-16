'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAnonKey, supabaseUrl } from './env';

let cached: SupabaseClient | null = null;

/**
 * Browser Supabase client, deliberately a singleton.
 *
 * Realtime holds one WebSocket per client instance; creating a second client
 * would open a second socket and double every presence entry.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (cached) return cached;
  cached = createBrowserClient(supabaseUrl(), supabaseAnonKey(), {
    realtime: {
      // Cursor movement is throttled hard before it reaches the socket; this is
      // the backstop so a burst of typing cannot saturate the channel.
      params: { eventsPerSecond: 25 },
    },
  });
  return cached;
}
