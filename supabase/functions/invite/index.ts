// Invite links, for the app. The rules live in _shared/invite.ts.
// "peek" works without an account (the welcome screen); "accept" needs one.
import { authenticate, corsHeaders, createAdminClient, json } from "../_shared/http.ts";
import { sendPushToUsers } from "../_shared/push.ts";
import { invite } from "../_shared/invite.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const user = body?.action === "accept" ? await authenticate(req) : null;
  const admin = createAdminClient();
  // The friendship is saved before the push goes out; a push service
  // hiccup doesn't fail the request.
  const push = async (userIds: string[], payload: { title: string; body: string }) => {
    try {
      await sendPushToUsers(admin, userIds, payload);
    } catch (err) {
      console.error("invite push failed", String((err as Error).message ?? err));
    }
  };

  try {
    const reply = await invite({ admin, push }, user ? user.id : null, body ?? {});
    return json(reply.body, reply.status);
  } catch (err) {
    console.error("invite failed", String((err as Error).message ?? err));
    return json({ ok: false, error: "server_error" }, 500);
  }
});
