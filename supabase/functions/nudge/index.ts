// Friend nudges, for the app. POST { friendId, timeZone }: sends your
// friend a push if they haven't trained yet today. The rules live in
// _shared/nudge.ts; the nudges table can't be written from the app.
import { authenticate, corsHeaders, createAdminClient, json } from "../_shared/http.ts";
import { sendPushToUsers } from "../_shared/push.ts";
import { nudge } from "../_shared/nudge.ts";

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

  const admin = createAdminClient();
  // The nudge is already recorded by the time the push goes out; a push
  // service hiccup doesn't fail the request.
  const push = async (userIds: string[], payload: { title: string; body: string }) => {
    try {
      await sendPushToUsers(admin, userIds, payload);
    } catch (err) {
      console.error("nudge push failed", String((err as Error).message ?? err));
    }
  };

  try {
    const reply = await nudge({ admin, push, now: Date.now() }, user.id, body ?? {});
    return json(reply.body, reply.status);
  } catch (err) {
    console.error("nudge failed", String((err as Error).message ?? err));
    return json({ ok: false, error: "server_error" }, 500);
  }
});
