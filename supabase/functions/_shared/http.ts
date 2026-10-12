// Helpers shared by every Edge Function: who is calling, how to reply, and
// the admin database client.
import { createClient } from "npm:@supabase/supabase-js@2";

// Needed because the app calls these functions straight from the browser,
// which sends a preflight OPTIONS request first and refuses the response
// unless these headers are present.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// The service-role client bypasses every RLS policy - which is exactly why
// only server code ever holds it, and why it's the only thing allowed to
// write verified results.
export function createAdminClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

// True when the call came from the database itself (a pg_cron job or a
// trigger): those send a secret kept in the database's Vault, which never
// appears in any file. The database checks it (is_internal_call, callable
// only with the service role), so the secret lives in one place. See
// sql/lock-internal-calls-2026-10-12.sql.
// deno-lint-ignore no-explicit-any
export async function isInternalCall(req: Request, admin: any) {
  const candidate = req.headers.get("x-internal-secret");
  if (!candidate) return false;
  const { data, error } = await admin.rpc("is_internal_call", { candidate });
  return !error && data === true;
}

// Works out who is calling from the login token the app attached, by
// asking Supabase Auth to validate it. Returns null if there isn't a valid
// one - never trust a user id sent in the request body.
export async function authenticate(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const asCaller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await asCaller.auth.getUser();
  return error || !data.user ? null : data.user;
}
