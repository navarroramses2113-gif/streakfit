// Permanently deletes the CALLER's own account. Apple requires any app with
// sign-up to offer this from inside the app, and the privacy policy promises
// it. Deleting the auth user is enough to remove everything: every table
// that stores a person's data (user_progress, profiles, friendships,
// blocked_users, reports, push_subscriptions, verified_sets, player_stats)
// references auth.users with `on delete cascade`, so the database removes
// all of those rows itself.
//
// Which account is deleted is decided only by the login token on the
// request - never by anything in the request body - so nobody can delete
// anyone else's. The body must also carry the typed confirmation, a second
// guard against an accidental or scripted call.
import { authenticate, corsHeaders, createAdminClient, json } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const user = await authenticate(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  if (body?.confirm !== "DELETE") return json({ ok: false, error: "not_confirmed" }, 400);

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) return json({ ok: false, error: "server_error" }, 500);

  return json({ ok: true });
});
