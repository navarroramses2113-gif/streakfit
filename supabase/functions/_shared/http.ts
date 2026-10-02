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
