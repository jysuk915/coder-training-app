import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const isConfigured =
  !SUPABASE_URL.includes('YOUR-PROJECT-ID') && !SUPABASE_ANON_KEY.includes('YOUR-ANON');

// True when this page load came from clicking an email sign-in link.
export const arrivedFromEmailLink = /access_token=|error_description=/.test(window.location.hash);
export const emailLinkError = (() => {
  const m = window.location.hash.match(/error_description=([^&]+)/);
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
})();

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    })
  : null;

export async function currentUser() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

// A trainer is a user signed in by email (coders are anonymous users).
export function isTrainerUser(user) {
  return !!user && !user.is_anonymous;
}

// Throw a readable error if a Supabase call failed; otherwise return its data.
export function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}
